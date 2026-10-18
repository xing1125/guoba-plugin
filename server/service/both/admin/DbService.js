import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 双库连接管理
 *
 * - bot.db ：Bot 主库（data/db/data.db），**只读**打开，绝不写入
 * - admin.db：后台自有库（data/db/admin.db），读写，WAL
 *
 * Bot 主库使用 sequelize + journal_mode=delete，读连接必须设 busy_timeout，
 * 且只做点查/小范围扫描，避免与 Bot 写事务互相阻塞。
 */
export class DbService extends Service {

  constructor(app) {
    super(app)
    this.botDbPath = path.join(_paths.data, 'db', 'data.db')
    this.adminDbPath = path.join(_paths.data, 'db', 'admin.db')
    this._botDb = null
    this._botDbFailed = false
    this._botDbWrite = null
    this._adminDb = null
  }

  /** Bot 主库（只读）。库不存在时返回 null，调用方需自行兜底 */
  getBotDb() {
    if (this._botDb) {
      return this._botDb
    }
    if (this._botDbFailed) {
      return null
    }
    try {
      if (!fs.existsSync(this.botDbPath)) {
        this._botDbFailed = true
        logger.warn(`[admin] Bot 主库不存在，账号相关接口将返回空数据：${this.botDbPath}`)
        return null
      }
      this._botDb = new Database(this.botDbPath, {readonly: true, fileMustExist: true})
      this._botDb.pragma('busy_timeout = 2000')
      return this._botDb
    } catch (e) {
      this._botDbFailed = true
      logger.error(`[admin] 打开 Bot 主库失败：${e.message}`)
      return null
    }
  }

  /**
   * Bot 主库（可写）—— **仅供后台的删除 / 编辑类操作使用**
   *
   * Bot 进程用 sequelize 打开同一文件（journal_mode=delete），
   * 这里只执行单行 UPDATE / DELETE，并设置较大的 busy_timeout，
   * 避免与 Bot 写事务互相阻塞；不做任何 DDL / 批量扫描。
   */
  getBotDbWrite() {
    if (this._botDbWrite) {
      return this._botDbWrite
    }
    if (!fs.existsSync(this.botDbPath)) {
      throw new Error(`Bot 主库不存在：${this.botDbPath}`)
    }
    this._botDbWrite = new Database(this.botDbPath, {fileMustExist: true})
    this._botDbWrite.pragma('busy_timeout = 5000')
    return this._botDbWrite
  }

  /** 后台自有库（读写），首次访问时自动建表 */
  getAdminDb() {
    if (this._adminDb) {
      return this._adminDb
    }
    const dir = path.dirname(this.adminDbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive: true})
    }
    this._adminDb = new Database(this.adminDbPath)
    this._adminDb.pragma('journal_mode = WAL')
    this._adminDb.pragma('busy_timeout = 2000')
    this.initSchema()
    return this._adminDb
  }

  initSchema() {
    this._adminDb.exec(`
      CREATE TABLE IF NOT EXISTS sync_meta (
        task       TEXT PRIMARY KEY,
        status     TEXT NOT NULL DEFAULT 'idle',
        last_start TEXT,
        last_end   TEXT,
        scanned    INTEGER DEFAULT 0,
        message    TEXT
      );

      CREATE TABLE IF NOT EXISTS account_status (
        ltuid      INTEGER PRIMARY KEY,
        ck_status  TEXT NOT NULL DEFAULT 'unknown',
        http_code  INTEGER,
        err_msg    TEXT,
        cost_ms    INTEGER,
        checked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_acc_checked ON account_status(checked_at);

      CREATE TABLE IF NOT EXISTS uid_index (
        uid       TEXT NOT NULL,
        game      TEXT NOT NULL,
        ltuid     INTEGER NOT NULL,
        synced_at TEXT,
        PRIMARY KEY (uid, game)
      );
      CREATE INDEX IF NOT EXISTS idx_uid_ltuid ON uid_index(ltuid);
      CREATE INDEX IF NOT EXISTS idx_uid_game  ON uid_index(game);

      CREATE TABLE IF NOT EXISTS group_stats (
        gid        TEXT NOT NULL,
        stat_date  TEXT NOT NULL,
        active_cnt INTEGER DEFAULT 0,
        msg_cnt    INTEGER DEFAULT 0,
        join_cnt   INTEGER DEFAULT 0,
        leave_cnt  INTEGER DEFAULT 0,
        updated_at TEXT,
        PRIMARY KEY (gid, stat_date)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor      TEXT,
        action     TEXT,
        target     TEXT,
        detail     TEXT,
        ip         TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

      /* 删除账号前的整行备份，用于误删恢复 */
      CREATE TABLE IF NOT EXISTS deleted_account (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ltuid      INTEGER NOT NULL,
        payload    TEXT NOT NULL,
        actor      TEXT,
        ip         TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deleted_ltuid ON deleted_account(ltuid);

      /* 昵称快照：Users.name 全为空，昵称只在 Bot 运行时内存里，
         由 StatsService 周期回写，保证后台随时可查、重启不丢 */
      CREATE TABLE IF NOT EXISTS user_name (
        uid        TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        source     TEXT,
        updated_at TEXT
      );
    `)
  }

  /** 写入同步任务状态 */
  setTaskStatus(task, patch = {}) {
    const db = this.getAdminDb()
    const exists = db.prepare('SELECT task FROM sync_meta WHERE task = ?').get(task)
    if (!exists) {
      db.prepare('INSERT INTO sync_meta (task, status) VALUES (?, ?)').run(task, patch.status || 'idle')
    }
    const fields = Object.keys(patch)
    if (fields.length === 0) {
      return
    }
    const sql = `UPDATE sync_meta SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE task = ?`
    db.prepare(sql).run(...fields.map((f) => patch[f]), task)
  }

  getTaskStatus(task) {
    return this.getAdminDb().prepare('SELECT * FROM sync_meta WHERE task = ?').get(task) || null
  }

  /** 写操作审计 */
  writeAudit({actor = '', action = '', target = '', detail = '', ip = ''} = {}) {
    try {
      this.getAdminDb()
        .prepare('INSERT INTO audit_log (actor, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(actor, action, String(target), typeof detail === 'string' ? detail : JSON.stringify(detail), ip, new Date().toISOString())
    } catch (e) {
      logger?.warn?.(`[admin] 写入审计日志失败：${e.message}`)
    }
  }

  /** 最近审计记录 */
  queryAudit({limit = 50} = {}) {
    return this.getAdminDb()
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(Math.min(200, Math.max(1, Number(limit) || 50)))
  }

  /** 备份被删除的账号（整行 + 关联记录） */
  backupDeletedAccount(ltuid, payload, {actor = '', ip = ''} = {}) {
    this.getAdminDb()
      .prepare('INSERT INTO deleted_account (ltuid, payload, actor, ip, deleted_at) VALUES (?, ?, ?, ?, ?)')
      .run(ltuid, JSON.stringify(payload), actor, ip, new Date().toISOString())
  }

  /** 被删除账号的备份列表 */
  listDeletedAccounts({limit = 100} = {}) {
    return this.getAdminDb()
      .prepare('SELECT id, ltuid, actor, deleted_at FROM deleted_account ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, Number(limit) || 100)))
  }

  /** 取某条删除备份 */
  getDeletedAccount(id) {
    const row = this.getAdminDb().prepare('SELECT * FROM deleted_account WHERE id = ?').get(Number(id))
    if (!row) {
      return null
    }
    try {
      row.payload = JSON.parse(row.payload)
    } catch {}
    return row
  }

  close() {
    try {
      this._botDb?.close()
    } catch {}
    try {
      this._botDbWrite?.close()
    } catch {}
    try {
      this._adminDb?.close()
    } catch {}
    this._botDb = null
    this._botDbWrite = null
    this._adminDb = null
  }
}
