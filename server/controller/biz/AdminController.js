import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 云崽管理后台接口
 *
 * 第 1 期全部只读：不提供任何写 Bot 主库的接口。
 * 所有路径挂在 /api/admin 下，自动走现有的 TokenInterceptor 鉴权。
 */
export default class AdminController extends ApiController {

  adminService = autowired('adminService')
  syncService = autowired('syncService')
  opsService = autowired('accountOpsService')

  constructor(guobaApp) {
    super('/admin', guobaApp)
    this._hits = new Map()
    // 启动定时同步（UID 索引 + 群快照），失败不影响主流程
    try {
      this.syncService.start?.()
    } catch (e) {
      globalThis.logger?.error?.(`[admin] 启动同步任务失败：${e.message}`)
    }
  }

  registerRouters() {
    this.get('/overview', this.overview)
    this.get('/accounts', this.accounts)
    this.get('/accounts/deleted', this.deletedAccounts)
    this.get('/accounts/:ltuid', this.accountDetail)
    this.post('/accounts/verify', this.verify)
    this.post('/accounts/update', this.updateAccount)
    this.post('/accounts/delete', this.deleteAccounts)
    this.post('/accounts/restore', this.restoreAccount)
    this.post('/accounts/delete-expired', this.deleteExpired)
    this.post('/uids/upsert', this.upsertUid)
    this.post('/uids/delete', this.deleteUid)
    this.get('/audit', this.audit)
    this.get('/uids', this.uids)
    this.get('/groups', this.groups)
    this.post('/sync', this.sync)
    this.get('/sync/status', this.syncStatus)
  }

  /** 写操作的来源信息（审计用） */
  _ctx(req) {
    const ua = req.headers?.['user-agent'] || ''
    return {
      actor: String(req.user?.username || req.body?.actor || 'master'),
      ip: String(req.ip || req.socket?.remoteAddress || ''),
      ua: ua.slice(0, 120),
    }
  }

  /** 危险操作二次确认：body.confirm 必须为 true 或字符串 'DELETE' */
  _confirmed(req) {
    const c = req.body?.confirm
    return c === true || c === 'DELETE' || c === 'delete'
  }

  /** 简易限流：同一 action 在 windowMs 内最多 times 次 */
  _rateLimit(req, action, times = 5, windowMs = 60_000) {
    const key = `${action}:${req.ip || req.socket?.remoteAddress || 'unknown'}`
    const now = Date.now()
    const list = (this._hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= times) {
      return false
    }
    list.push(now)
    this._hits.set(key, list)
    // 清理过期 key，避免长期运行内存增长
    if (this._hits.size > 500) {
      for (const [k, v] of this._hits) {
        if (!v.some((t) => now - t < windowMs)) this._hits.delete(k)
      }
    }
    return true
  }

  // ------------------------------------------------------------ 查询

  async overview() {
    return Result.ok(await this.adminService.getOverview())
  }

  async accounts(req) {
    const {page, size, q, ckStatus, game} = req.query
    const data = this.adminService.queryAccounts({
      page: Number(page) || 1,
      size: Number(size) || 20,
      q: q ? String(q).trim() : '',
      ckStatus: ckStatus ? String(ckStatus) : '',
      game: game ? String(game) : '',
    })
    return Result.ok(data)
  }

  async accountDetail(req) {
    const ltuid = Number(req.params.ltuid)
    if (!ltuid) {
      return Result.error('ltuid 不合法')
    }
    const data = this.adminService.getAccount(ltuid)
    if (!data) {
      return Result.error(`未找到账号 ${ltuid}`)
    }
    return Result.ok(data)
  }

  async uids(req) {
    const {game, page, size, q} = req.query
    // waves 分支需异步读 redis（MysUsers 路径为同步 SQL），统一 await
    const data = await this.adminService.queryUids({
      game: game ? String(game) : 'gs',
      page: Number(page) || 1,
      size: Number(size) || 20,
      q: q ? String(q).trim() : '',
    })
    return Result.ok(data)
  }

  async groups() {
    return Result.ok({list: this.adminService.queryGroups()})
  }

  // ------------------------------------------------------------ 动作

  async verify(req) {
    if (!this._rateLimit(req, 'verify', 5, 60_000)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    let {ltuids, concurrency} = req.body || {}
    if (!Array.isArray(ltuids) || ltuids.length === 0) {
      return Result.error('ltuids 不能为空')
    }
    ltuids = ltuids.map(Number).filter(Boolean)
    if (ltuids.length === 0) {
      return Result.error('ltuids 不合法')
    }
    if (ltuids.length > 20) {
      return Result.error('单次最多校验 20 个账号')
    }
    const limit = Math.min(Math.max(1, Number(concurrency) || 3), 5)
    const data = await this.adminService.verifyAccounts(ltuids, limit)
    return Result.ok(data)
  }

  async sync(req) {
    if (!this._rateLimit(req, 'sync', 5, 60_000)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    const task = req.body?.task ? String(req.body.task) : 'all'
    const result = await this.syncService.run(task)
    return Result.ok({result})
  }

  async syncStatus() {
    return Result.ok(this.syncService.getStatus())
  }

  // ------------------------------------------------------------ 写操作

  /** 编辑账号（CK / device / device_fp / uids） */
  async updateAccount(req) {
    if (!this._rateLimit(req, 'accUpdate', 30, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const ltuid = Number(req.body?.ltuid)
    if (!ltuid) {
      return Result.error('ltuid 不合法')
    }
    const patch = req.body?.patch || {}
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return Result.error('没有需要修改的字段')
    }
    try {
      const data = this.opsService.updateAccount(ltuid, patch, this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 删除账号（必须二次确认） */
  async deleteAccounts(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'accDelete', 10, 60_000)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    const ltuids = Array.isArray(req.body?.ltuids) ? req.body.ltuids.map(Number).filter(Boolean) : []
    if (ltuids.length === 0) {
      return Result.error('ltuids 不能为空')
    }
    if (ltuids.length > 100) {
      return Result.error('单次最多删除 100 个账号')
    }
    try {
      const data = this.opsService.deleteAccounts(ltuids, this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 一键清理所有 CK 失效账号 */
  async deleteExpired(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'accDelExpired', 3, 60_000)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    try {
      const data = this.opsService.deleteExpired(this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 从删除备份恢复 */
  async restoreAccount(req) {
    if (!this._rateLimit(req, 'accRestore', 10, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const id = Number(req.body?.id)
    if (!id) {
      return Result.error('备份 id 不合法')
    }
    try {
      const data = this.opsService.restoreAccount(id, this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 删除备份列表 */
  async deletedAccounts(req) {
    const limit = Number(req.query?.limit) || 100
    return Result.ok({list: this.opsService.listDeleted(limit)})
  }

  /** 解绑一个 UID */
  /** 手动添加 / 修改一个 UID（origin 传原 UID 即为编辑） */
  async upsertUid(req) {
    if (!this._rateLimit(req, 'uidUpsert', 30, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const {ltuid, game, uid, origin} = req.body || {}
    if (String(game) === 'waves') {
      return Result.error('鸣潮 UID 由库街区 token 绑定，请通过 #ww 指令在聊天中管理，本页不支持编辑')
    }
    if (!ltuid || !game || !uid) {
      return Result.error('ltuid / game / uid 都不能为空')
    }
    try {
      const data = this.opsService.upsertUid({
        ltuid: Number(ltuid),
        game: String(game),
        uid: String(uid),
        origin: origin ? String(origin) : '',
        ctx: this._ctx(req),
      })
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async deleteUid(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'uidDelete', 20, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const {ltuid, game, uid} = req.body || {}
    if (String(game) === 'waves') {
      return Result.error('鸣潮 UID 由库街区 token 绑定，请通过 #ww 指令在聊天中管理，本页不支持解绑')
    }
    if (!ltuid || !game || !uid) {
      return Result.error('ltuid / game / uid 都不能为空')
    }
    try {
      const data = this.opsService.deleteUid(Number(ltuid), String(game), String(uid), this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 操作审计日志 */
  async audit(req) {
    const limit = Number(req.query?.limit) || 50
    return Result.ok({list: this.opsService.listAudit(limit)})
  }
}
