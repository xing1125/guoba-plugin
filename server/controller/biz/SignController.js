import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 游戏签到数据接口
 *
 * 数据源：
 *  - Lotus-Plugin 的签到审计流水（data/audit/checkin.jsonl）→ /admin/sign/*
 *  - Cloudtide Waves-plugin 的签到计划归档（data/schedules/*.json）→ /admin/sign/waves/*
 * 全部只读，不触碰 Bot 主库。
 */
export default class SignController extends ApiController {

  signService = autowired('signService')

  wavesSignService = autowired('wavesSignService')

  opsService = autowired('accountOpsService')

  constructor(guobaApp) {
    super('/admin/sign', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/overview', this.overview)
    this.get('/records', this.records)
    this.get('/day/:date', this.day)
    this.get('/issues', this.issues)
    this.post('/issues/clean', this.cleanIssues)
    this.post('/users/delete', this.deleteUsers)
    this.post('/users/restore', this.restoreUser)
    this.get('/waves/overview', this.wavesOverview)
    this.get('/waves/records', this.wavesRecords)
    this.get('/waves/day/:date', this.wavesDay)
  }

  /* ------------------------------ 写操作工具 ------------------------------ */

  _ctx(req) {
    return {
      actor: String(req.user?.username || req.body?.actor || 'master'),
      ip: String(req.ip || req.socket?.remoteAddress || ''),
      ua: String(req.headers?.['user-agent'] || '').slice(0, 120),
    }
  }

  _confirmed(req) {
    const c = req.body?.confirm
    return c === true || c === 'DELETE' || c === 'delete'
  }

  _rateLimit(req, action, times = 5, windowMs = 60_000) {
    const key = `${action}:${req.ip || req.socket?.remoteAddress || 'unknown'}`
    const now = Date.now()
    const list = (this._hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= times) {
      return false
    }
    list.push(now)
    this._hits.set(key, list)
    if (this._hits.size > 500) {
      for (const [k, v] of this._hits) {
        if (!v.some((t) => now - t < windowMs)) this._hits.delete(k)
      }
    }
    return true
  }

  async overview(req) {
    const days = Number(req.query?.days) || 14
    const data = this.signService.getOverview(days)
    if (!data.available) {
      return Result.error('没有找到签到流水文件（Lotus-Plugin/data/audit/checkin.jsonl）')
    }
    return Result.ok(data)
  }

  async records(req) {
    const {date, q, ok, game, status, page, size} = req.query || {}
    const data = this.signService.queryRecords({
      date: date ? String(date) : '',
      q: q ? String(q) : '',
      ok: ok ? String(ok) : '',
      game: game ? String(game) : '',
      status: status ? String(status) : '',
      page: Number(page) || 1,
      size: Number(size) || 20,
    })
    return Result.ok(data)
  }

  async day(req) {
    const date = req.params?.date ? String(req.params.date) : ''
    const data = this.signService.getDay(date)
    return Result.ok(data.available ? data : {...data, userList: [], accountList: []})
  }

  /* ------------------------ 异常账号清单 / 清理 ------------------------ */

  /** 异常清单：CK 失效账号 / 无效用户 / 长期失败账号（只读预览） */
  async issues(req) {
    const days = Number(req.query?.days) || 7
    const limit = Number(req.query?.limit) || 300
    const data = this.signService.getIssues({days, limit})
    return Result.ok(data)
  }

  /**
   * 执行清理
   * body: { scope: 'expired'|'orphan'|'stale', ids?: string[], confirm: true }
   *  - expired：删 CK 失效的米游社账号（走 deleteExpired / deleteAccounts）
   *  - orphan ：删无绑定 / 悬空绑定的微信号（Users 行）
   *  - stale  ：只统计，不支持删除，返回 skipped
   */
  async cleanIssues(req) {
    if (!this._confirmed(req)) {
      return Result.error('危险操作需要二次确认（confirm=true）')
    }
    if (!this._rateLimit(req, 'sign.issues.clean', 3, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const scope = String(req.body?.scope || '').trim()
    if (!['expired', 'orphan', 'stale'].includes(scope)) {
      return Result.error('scope 只能是 expired / orphan / stale')
    }
    if (scope === 'stale') {
      return Result.ok({scope, skipped: true, message: '长期失败账号仅作展示，不执行删除（账号可能只是暂时风控或未绑定角色）'})
    }

    const ctx = this._ctx(req)
    const picked = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x).trim()).filter(Boolean) : []

    try {
      if (scope === 'expired') {
        // 未指定 ids = 全量清（走现成的 deleteExpired）
        if (picked.length === 0) {
          const res = this.opsService.deleteExpired({...ctx, action: 'account.deleteExpired'})
          return Result.ok({scope, ...res})
        }
        const res = this.opsService.deleteAccounts(picked.map(Number).filter(Boolean), ctx)
        return Result.ok({scope, ...res})
      }
      // orphan
      if (picked.length === 0) {
        return Result.error('请先勾选要清理的用户')
      }
      const res = this.opsService.deleteOrphanUsers(picked, ctx)
      return Result.ok({scope, ...res})
    } catch (e) {
      return Result.error(`清理失败：${e.message}`)
    }
  }

  /** 单独删除微信号（Users 行），用于用户在账号页手动删 */
  async deleteUsers(req) {
    if (!this._confirmed(req)) {
      return Result.error('危险操作需要二次确认（confirm=true）')
    }
    if (!this._rateLimit(req, 'sign.users.delete', 5, 60_000)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x).trim()).filter(Boolean) : []
    if (ids.length === 0) {
      return Result.error('请提供要删除的用户 ID')
    }
    try {
      return Result.ok(this.opsService.deleteOrphanUsers(ids, this._ctx(req)))
    } catch (e) {
      return Result.error(`删除失败：${e.message}`)
    }
  }

  /** 从备份恢复被清理的微信号 */
  async restoreUser(req) {
    const id = Number(req.body?.id)
    if (!id) {
      return Result.error('请提供备份 ID')
    }
    try {
      return Result.ok(this.opsService.restoreUser(id, this._ctx(req)))
    } catch (e) {
      return Result.error(`恢复失败：${e.message}`)
    }
  }

  /* ------------------------------ 鸣潮签到 ------------------------------ */

  async wavesOverview(req) {
    const days = Number(req.query?.days) || 14
    const data = this.wavesSignService.getOverview(days)
    if (!data.available) {
      return Result.error('没有找到鸣潮签到归档（Cloudtide Waves-plugin/data/schedules/*.json）')
    }
    return Result.ok(data)
  }

  async wavesRecords(req) {
    const {date, q, ok, page, size} = req.query || {}
    const data = this.wavesSignService.queryRecords({
      date: date ? String(date) : '',
      q: q ? String(q) : '',
      ok: ok ? String(ok) : '',
      page: Number(page) || 1,
      size: Number(size) || 20,
    })
    return Result.ok(data)
  }

  async wavesDay(req) {
    const date = req.params?.date ? String(req.params.date) : ''
    const data = this.wavesSignService.getDay(date)
    return Result.ok(data.available ? data : {...data, userList: []})
  }
}
