import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 荧（YingAI）心智观测 + 干预接口
 *
 * GET  /admin/yingmind/groups            有数据的群列表（附群名/记忆数/关系数/情绪）
 * GET  /admin/yingmind/memories?gid=     某群记忆列表（按重要度降序）
 * GET  /admin/yingmind/relations?gid=    某群关系列表 + 里程碑
 * GET  /admin/yingmind/emotion?gid=      某群情绪快照
 * GET  /admin/yingmind/health?gid=       记忆体检报告（gid 空则扫全部真实群）
 * POST /admin/yingmind/memories/delete   删除记忆 {gid, index, oldText, confirm}
 * POST /admin/yingmind/memories/update   编辑记忆 {gid, index, text, value, oldText, confirm}
 * POST /admin/yingmind/emotion/set       校正情绪 {gid, mood, value, confirm}
 * POST /admin/yingmind/cleanup           批量清理体检候选 {keys: [{gid, index, oldText}], confirm}
 */
export default class YingMindController extends ApiController {

  yingMindService = autowired('yingMindService')
  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/admin/yingmind', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/groups', this.groups)
    this.get('/memories', this.memories)
    this.get('/relations', this.relations)
    this.get('/emotion', this.emotion)
    this.get('/health', this.health)
    this.post('/memories/delete', this.deleteMemory)
    this.post('/memories/update', this.updateMemory)
    this.post('/emotion/set', this.setEmotion)
    this.post('/cleanup', this.cleanup)
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

  async groups() {
    return Result.ok(this.yingMindService.groups())
  }

  async memories(req) {
    return Result.ok(this.yingMindService.memories(req.query?.gid))
  }

  async relations(req) {
    return Result.ok(this.yingMindService.relations(req.query?.gid))
  }

  async emotion(req) {
    return Result.ok(this.yingMindService.emotion(req.query?.gid))
  }

  async health(req) {
    const q = req.query || {}
    return Result.ok(this.yingMindService.health(q.gid || '', {
      staleDays: q.staleDays,
      lowValue: q.lowValue,
      minAge: q.minAge,
    }))
  }

  /* ------------------------------ 写 ------------------------------ */

  async deleteMemory(req) {
    const {gid, index, oldText} = req.body || {}
    if (!this._confirmed(req)) return Result.error('缺少二次确认（confirm）')
    if (!this._rateLimit(req, 'ymMemDel', 10)) return Result.error('操作过于频繁，稍后再试')
    try {
      const data = await this.yingMindService.deleteMemory(gid, index, oldText)
      this._audit(req, 'yingmind.memory.delete', gid, `删除记忆#${index}: ${String(data.text).slice(0, 40)}`)
      return Result.ok(data, '已删除')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async updateMemory(req) {
    const {gid, index, text, value, oldText} = req.body || {}
    if (!this._confirmed(req)) return Result.error('缺少二次确认（confirm）')
    if (!this._rateLimit(req, 'ymMemUpd', 10)) return Result.error('操作过于频繁，稍后再试')
    try {
      const data = await this.yingMindService.updateMemory(gid, index, {text, value}, oldText)
      this._audit(req, 'yingmind.memory.update', gid, `编辑记忆#${index}`)
      return Result.ok(data, '已保存')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async setEmotion(req) {
    const {gid, mood, value} = req.body || {}
    if (!this._confirmed(req)) return Result.error('缺少二次确认（confirm）')
    if (!this._rateLimit(req, 'ymEmo', 10)) return Result.error('操作过于频繁，稍后再试')
    try {
      const data = await this.yingMindService.setEmotion(gid, {mood, value})
      this._audit(req, 'yingmind.emotion.set', gid, `校正情绪: ${data.mood} ${data.value}`)
      return Result.ok(data, '已校正')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async cleanup(req) {
    const {keys} = req.body || {}
    if (!this._confirmed(req)) return Result.error('缺少二次确认（confirm）')
    if (!this._rateLimit(req, 'ymClean', 5)) return Result.error('操作过于频繁，稍后再试')
    try {
      const data = await this.yingMindService.cleanupMemories(keys)
      // 跨群清理时 target 记 all
      const gids = [...new Set((Array.isArray(keys) ? keys : [])
        .map((k) => String(k?.gid || '').replace('@chatroom', ''))
        .filter(Boolean))]
      const target = gids.length === 1 ? gids[0] : 'all'
      this._audit(req, 'yingmind.memory.cleanup', target, `清理 ${data.removed} 条，备份 ${data.backupDir}`)
      return Result.ok(data, `已清理 ${data.removed} 条`)
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
