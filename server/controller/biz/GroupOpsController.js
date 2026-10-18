import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 群操作接口（写操作）
 *
 * POST /admin/groups/batch-clear  批量清活跃/清拓展数据
 * GET  /admin/groups/roles/:gid   群主/群管名单
 * POST /admin/groups/role         设置/取消群主或群管理员
 */
export default class GroupOpsController extends ApiController {

  groupOpsService = autowired('groupOpsService')
  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/admin/groups', guobaApp)
  }

  registerRouters() {
    this.post('/batch-clear', this.batchClear)
    this.get('/invalid', this.invalid)
    this.post('/quit', this.quit)
    this.get('/roles/:gid', this.roles)
    this.post('/role', this.setRole)
    this.get('/ai', this.aiSwitches)
    this.post('/ai', this.setAISwitch)
    this.get('/ops-log', this.opsLog)
  }

  /** 写审计（actor 取 JWT 注入的登录用户） */
  _audit(req, action, target, detail) {
    try {
      this.dbService?.writeAudit?.({
        actor: String(req.user?.username || req.body?.actor || ''),
        action,
        target: String(target ?? ''),
        detail: detail ?? '',
        ip: String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      })
    } catch {
      /* 审计失败不阻断主流程 */
    }
  }

  async _guard() {
    if (!globalThis.redis) {
      return Result.error('Redis 未就绪，请确认 Bot 已正常启动')
    }
    return null
  }

  /** 批量清数据 {gids: string[], scope: 'activity'|'ext'|'all'} */
  async batchClear(req) {
    const err = await this._guard()
    if (err) return err
    const {gids, scope} = req.body || {}
    if (!Array.isArray(gids) || !gids.length) return Result.error('未指定群号')
    try {
      const data = await this.groupOpsService.clearGroups(gids, String(scope || 'activity'))
      this._audit(req, 'group.clear', gids.join(','), {scope, deleted: data?.deleted ?? data})
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 无效群检测：left=已退群残留 / idle=在群但近14天零消息 / low=近14天低活跃（仅标记） */
  async invalid(req) {
    const err = await this._guard()
    if (err) return err
    const lowLimit = Number(req.query?.lowLimit) || 100
    try {
      const data = await this.groupOpsService.getInvalidGroups(lowLimit)
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 退群 {gid}（高危操作，仅当 Bot 确实在该群时执行） */
  async quit(req) {
    const err = await this._guard()
    if (err) return err
    const {gid} = req.body || {}
    if (!gid) return Result.error('未指定群号')
    try {
      const data = await this.groupOpsService.quitGroup(gid)
      this._audit(req, 'group.quit', gid, data)
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 群主/群管名单 */
  async roles(req) {
    const err = await this._guard()
    if (err) return err
    const gid = decodeURIComponent(String(req.params?.gid || ''))
    if (!gid) return Result.error('群号不合法')
    try {
      const data = await this.groupOpsService.getGroupRoles(gid)
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 设置/取消身份 {gid, role: 'owner'|'groupAdmin', uids: string[], add: boolean} */
  async setRole(req) {
    const err = await this._guard()
    if (err) return err
    const {gid, role, uids, add} = req.body || {}
    if (!gid) return Result.error('未指定群号')
    try {
      const data = await this.groupOpsService.setGroupRole(gid, String(role || ''), uids, add !== false)
      this._audit(req, 'group.set-role', gid, {role, uids, add: add !== false})
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** AI 分群开关状态 ?gids=a,b,c → {ying:{gid:bool}, gm:{gid:bool}} */
  async aiSwitches(req) {
    const err = await this._guard()
    if (err) return err
    const raw = String(req.query?.gids || '')
    const gids = raw.split(',').filter(Boolean)
    if (!gids.length) return Result.error('未指定群号')
    try {
      const data = await this.groupOpsService.getAISwitches(gids)
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 批量设置 AI 开关 {scope: 'ying'|'gm', gids: string[], off: boolean} */
  async setAISwitch(req) {
    const err = await this._guard()
    if (err) return err
    const {scope, gids, off} = req.body || {}
    if (!Array.isArray(gids) || !gids.length) return Result.error('未指定群号')
    try {
      const data = await this.groupOpsService.setAISwitch(String(scope || ''), gids, off === true)
      this._audit(req, 'group.ai-switch', gids.join(','), {scope, off: off === true})
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 操作日志 ?limit=50 */
  async opsLog(req) {
    const err = await this._guard()
    if (err) return err
    const limit = Number(req.query?.limit) || 50
    const data = await this.groupOpsService.getOpsLog(limit)
    return Result.ok(data)
  }
}
