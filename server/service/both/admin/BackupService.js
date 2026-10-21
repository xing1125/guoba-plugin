import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 数据健康与备份服务
 *
 * 库文件：
 *   - data/db/data.db  Bot 主库（Bot 进程持有，这里只读热备）
 *   - data/db/admin.db 后台自有库（本进程持有，可 checkpoint / 修复式恢复）
 *
 * 备份形态：目录快照 data/db/backups/<时间戳>/
 *   data.db + admin.db + manifest.json（大小 / SHA256 / integrity_check）
 * SQLite 在线 .backup API 产出一致性快照，不需要停机。
 */

const BACKUP_KEEP = 10

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })

export class BackupService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    this.dbDir = path.join(_paths.data, 'db')
    this.backupDir = path.join(this.dbDir, 'backups')
  }

  get dbs() {
    return {
      data: {key: 'data', label: 'Bot 主库', file: path.join(this.dbDir, 'data.db')},
      admin: {key: 'admin', label: '后台库', file: path.join(this.dbDir, 'admin.db')},
    }
  }

  /** 后台库连接（经由 DbService 复用，避免多开） */
  _adminDb() {
    return this.dbService?.getAdminDb?.() ?? null
  }

  // ---------------------------------------------------------------- 健康

  async health() {
    const out = {dbs: [], backupDir: this.backupDir, backupCount: 0, lastBackupAt: null, redisKeys: 0}
    for (const info of Object.values(this.dbs)) {
      const item = {key: info.key, label: info.label, file: info.file, exists: fs.existsSync(info.file)}
      if (item.exists) {
        const st = fs.statSync(info.file)
        item.size = st.size
        item.mtime = st.mtime.toISOString()
        item.wal = this._walSize(info.file)
        try {
          const db = new Database(info.file, {readonly: true, fileMustExist: true})
          item.integrity = String(db.pragma('integrity_check', {simple: true}))
          item.tables = db
            .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
            .all()
            .map((t) => {
              let rows = 0
              try {
                rows = db.prepare(`select count(*) n from "${t.name}"`).get().n
              } catch {}
              return {name: t.name, rows}
            })
          db.close()
        } catch (e) {
          item.integrity = `打开失败：${e.message}`
          item.tables = []
        }
      }
      out.dbs.push(item)
    }
    try {
      out.backupCount = fs.existsSync(this.backupDir)
        ? fs.readdirSync(this.backupDir).filter((d) => /^\d{8}-\d{6}$/.test(d)).length
        : 0
      const list = await this.list(1)
      out.lastBackupAt = list[0]?.at ?? null
    } catch {}
    try {
      if (globalThis.redis) out.redisKeys = await globalThis.redis.dBSize()
    } catch {}
    return out
  }

  _walSize(file) {
    const p = file + '-wal'
    return {size: fs.existsSync(p) ? fs.statSync(p).size : 0}
  }

  // ---------------------------------------------------------------- 备份

  /** 热备两个库到 backups/<ts>/，返回 manifest */
  async create() {
    const ts = this._ts()
    const dir = path.join(this.backupDir, ts)
    fs.mkdirSync(dir, {recursive: true})
    const files = []
    for (const info of Object.values(this.dbs)) {
      if (!fs.existsSync(info.file)) continue
      const dest = path.join(dir, path.basename(info.file))
      const src = new Database(info.file, {readonly: true, fileMustExist: true})
      try {
        await src.backup(dest)
      } finally {
        src.close()
      }
      let integrity = 'ok'
      try {
        const chk = new Database(dest, {readonly: true, fileMustExist: true})
        integrity = String(chk.pragma('integrity_check', {simple: true}))
        chk.close()
      } catch (e) {
        integrity = `校验失败：${e.message}`
      }
      files.push({
        name: path.basename(info.file),
        label: info.label,
        size: fs.statSync(dest).size,
        sha256: await sha256(dest),
        integrity,
      })
    }
    const manifest = {at: new Date().toISOString(), ts, files}
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return manifest
  }

  async list(limit = 20) {
    if (!fs.existsSync(this.backupDir)) return []
    const dirs = fs
      .readdirSync(this.backupDir)
      .filter((d) => /^\d{8}-\d{6}$/.test(d))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    return dirs.map((d) => {
      const dir = path.join(this.backupDir, d)
      let manifest = null
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      } catch {}
      let total = 0
      try {
        for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size
      } catch {}
      return {
        ts: d,
        at: manifest?.at ?? this._tsToDate(d),
        total,
        files:
          manifest?.files ??
          fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.db'))
            .map((f) => ({name: f, size: fs.statSync(path.join(dir, f)).size})),
        complete: !!manifest,
      }
    })
  }

  /** 轮转：保留最近 keep 份 */
  async prune(keep = BACKUP_KEEP) {
    const n = Math.max(1, Math.min(50, Number(keep) || BACKUP_KEEP))
    if (!fs.existsSync(this.backupDir)) return {removed: []}
    const dirs = fs
      .readdirSync(this.backupDir)
      .filter((d) => /^\d{8}-\d{6}$/.test(d))
      .sort()
    const removed = dirs.slice(0, Math.max(0, dirs.length - n))
    for (const d of removed) {
      try {
        fs.rmSync(path.join(this.backupDir, d), {recursive: true, force: true})
      } catch {}
    }
    return {removed, kept: dirs.length - removed.length}
  }

  /** 后台库 WAL 收缩（Bot 主库是 journal_mode=delete，无 WAL） */
  async checkpoint() {
    const db = this._adminDb()
    if (!db) throw new Error('后台库未就绪')
    const before = this._walSize(this.dbs.admin.file).size
    const res = db.pragma('wal_checkpoint(TRUNCATE)')
    const after = this._walSize(this.dbs.admin.file).size
    return {before, after, result: res}
  }

  /**
   * 恢复备份（危险操作，需 confirm）
   * 尽力直接覆盖；Windows 下文件被占用时转为暂存 *.restore-pending，
   * 提示停机后手动替换。
   */
  async restore(ts, confirm = false) {
    if (!confirm) throw new Error('恢复会覆盖现有数据库，需二次确认')
    if (!/^\d{8}-\d{6}$/.test(String(ts))) throw new Error('备份时间戳不合法')
    const dir = path.join(this.backupDir, ts)
    if (!fs.existsSync(dir)) throw new Error('备份不存在')
    const results = []
    for (const info of Object.values(this.dbs)) {
      const src = path.join(dir, path.basename(info.file))
      if (!fs.existsSync(src)) continue
      const dest = info.file
      const r = {db: info.key, mode: 'direct', ok: false}
      try {
        if (info.key === 'admin') {
          // 本进程持有的库：先关连接再覆盖，之后下次访问会自动重开
          try {
            this.dbService?._adminDb?.close?.()
          } catch {}
          try {
            this.dbService && (this.dbService._adminDb = null)
          } catch {}
        }
        fs.copyFileSync(src, dest)
        for (const suffix of ['-wal', '-shm']) {
          const p = dest + suffix
          if (fs.existsSync(p)) fs.rmSync(p, {force: true})
        }
        r.ok = true
      } catch (e) {
        r.mode = 'pending'
        try {
          fs.copyFileSync(src, dest + '.restore-pending')
          r.ok = true
          r.note = '文件被占用，已暂存为 *.restore-pending；停止 Bot 后手动替换'
        } catch (e2) {
          r.error = e2.message
        }
      }
      results.push(r)
    }
    return {ts, results}
  }

  // ---------------------------------------------------------------- 内部

  _ts(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  _tsToDate(ts) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(ts || '')
    if (!m) return ts
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString()
  }
}

export default BackupService
