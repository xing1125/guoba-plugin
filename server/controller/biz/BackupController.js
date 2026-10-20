import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 数据健康与备份接口
 *
 * GET  /admin/db/health              两库健康（体积/WAL/行数/完整性/最后备份）
 * GET  /admin/db/backups             备份列表（?limit=20）
 * POST /admin/db/backup              立即热备
 * POST /admin/db/checkpoint          后台库 WAL 收缩
 * POST /admin/db/prune               轮转旧备份 {keep}
 * POST /admin/db/restore             恢复备份 {ts, confirm}
 *
 * 破坏性操作（备份 / 收缩 / 轮转 / 恢复）一律限流 + 落审计。
 */
export default class BackupController extends ApiController {

  backupService = autowired('backupService')
  dbService = autowired('dbService')

  /** 限流计数：action:ip -> 时间戳数组 */
  _hits = new Map()

  constructor(guobaApp) {
    super('/admin/db', guobaApp)
  }

  registerRouters() {
    this.get('/health', this.health)
    this.get('/backups', this.backups)
    this.post('/backup', this.createBackup)
    this.post('/checkpoint', this.checkpoint)
    this.post('/prune', this.prune)
    this.post('/restore', this.restore)
  }

  _rateLimit(req, action, times = 10, windowMs = 60_000) {
    const key = `${action}:${req.ip || ''}`
    const now = Date.now()
    const list = (this._hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= times) return false
    list.push(now)
    this._hits.set(key, list)
    return true
  }

  _ctx(req) {
    return {actor: req?.user?.username || 'unknown', ip: req?.ip || ''}
  }

  _audit(req, action, target, detail) {
    try {
      this.dbService?.writeAudit?.({...this._ctx(req), action, target, detail})
    } catch {}
  }

  async health() {
    try {
      return Result.ok(await this.backupService.health())
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async backups(req) {
    const limit = Number(req.query?.limit) || 20
    try {
      return Result.ok(await this.backupService.list(limit))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async createBackup(req) {
    if (!this._rateLimit(req, 'dbBackup', 6, 60_000)) {
      return Result.error('备份过于频繁，请稍后再试')
    }
    try {
      const data = await this.backupService.create()
      this._audit(req, 'db.backup', `db/backups/${data.ts}`, {
        files: data.files?.map((f) => ({name: f.name, size: f.size})),
      })
      return Result.ok(data, '备份完成')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async checkpoint(req) {
    if (!this._rateLimit(req, 'dbCheckpoint', 10, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = await this.backupService.checkpoint()
      this._audit(req, 'db.checkpoint', 'db/admin.db', data)
      return Result.ok(data, 'WAL 已收缩')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async prune(req) {
    if (!this._rateLimit(req, 'dbPrune', 5, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const {keep} = req.body || {}
    try {
      const data = await this.backupService.prune(keep)
      if (data?.removed?.length) {
        this._audit(req, 'db.prune', 'db/backups', {keep, removed: data.removed})
      }
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async restore(req) {
    if (!this._rateLimit(req, 'dbRestore', 3, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const {ts, confirm} = req.body || {}
    try {
      const data = await this.backupService.restore(ts, confirm === true || confirm === 'true')
      this._audit(req, 'db.restore', `db/backups/${ts}`, {
        results: data?.results?.map((r) => ({db: r.db, mode: r.mode, ok: r.ok})),
      })
      return Result.ok(data, '恢复完成，建议尽快重启 Bot')
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
