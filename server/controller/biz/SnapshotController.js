import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 每日快照：情绪曲线 / 战力趋势的时序数据
 *
 * GET  /admin/snapshots/list?days=      快照文件列表 + 最新一天概况
 * GET  /admin/snapshots/emotion?gid=&days=  情绪曲线（gid 空 = 全站平均）
 * GET  /admin/snapshots/rank?gid=&days=     战力趋势（gid 空 = 全站汇总）
 * POST /admin/snapshots/take            立刻采集一次 {confirm}
 */
export default class SnapshotController extends ApiController {

  snapshotService = autowired('snapshotService')
  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/admin/snapshots', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/list', this.list)
    this.get('/emotion', this.emotion)
    this.get('/rank', this.rank)
    this.post('/take', this.take)
  }

  /* ------------------------------ 写接口守卫 ------------------------------ */

  /** 危险操作二次确认：body.confirm 必须为 true */
  _confirmed(req) {
    return req.body?.confirm === true
  }

  /** 简易限流：同一 action 在 windowMs 内最多 times 次 */
  _rateLimit(req, action, times = 10, windowMs = 60_000) {
    const key = `${action}:${req.ip || req.socket?.remoteAddress || 'unknown'}`
    const now = Date.now()
    const list = (this._hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= times) return false
    list.push(now)
    this._hits.set(key, list)
    return true
  }

  /** 写审计（actor 取 JWT 注入的登录用户） */
  _audit(req, action, target, detail) {
    try {
      this.dbService?.writeAudit?.({
        actor: String(req.user?.username || ''),
        action,
        target: String(target ?? ''),
        detail: detail ?? '',
        ip: String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      })
    } catch { /* 审计失败不阻断主流程 */ }
  }

  /* ------------------------------ 读 ------------------------------ */

  async list(req) {
    try {
      return Result.ok(this.snapshotService.list(req.query?.days))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async emotion(req) {
    try {
      const q = req.query || {}
      return Result.ok(this.snapshotService.emotionTrend({gid: q.gid || '', days: q.days}))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async rank(req) {
    try {
      const q = req.query || {}
      return Result.ok(this.snapshotService.rankTrend({gid: q.gid || '', days: q.days}))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /* ------------------------------ 写 ------------------------------ */

  /** 立刻重采当天快照（运维用，一天多次就是覆盖） */
  async take(req) {
    if (!this._confirmed(req)) return Result.error('缺少二次确认（confirm）')
    if (!this._rateLimit(req, 'snapTake', 5)) return Result.error('操作过于频繁，稍后再试')
    try {
      const data = await this.snapshotService.take(true)
      this._audit(req, 'snapshot.take', data.date, `手动采集：情绪 ${data.emotion.length} 条 / 战力 ${data.rank.length} 群`)
      return Result.ok(data, '已采集')
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
