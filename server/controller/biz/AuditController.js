import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 审计日志接口（RBAC 阶段 3）
 *
 *  GET /api/admin/audit/list       分页 + 筛选（actor / action / 时间区间 / 关键词）
 *  GET /api/admin/audit/stats      概览（总量 / 今日 / 高危 / 分布）
 *  GET /api/admin/audit/actions    出现过的 action 去重列表（筛选下拉用）
 *  GET /api/admin/audit/feed       最近 N 条（顶部通知中心）
 *  GET /api/admin/audit/login-log  登录日志分页
 */
export default class AuditController extends ApiController {

  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/admin/audit', guobaApp)
  }

  registerRouters() {
    this.get('/list', this.list)
    this.get('/stats', this.stats)
    this.get('/actions', this.actions)
    this.get('/feed', this.feed)
    this.get('/login-log', this.loginLog)
  }

  async list(req) {
    try {
      const q = req.query || {}
      const data = this.dbService.queryAuditPaged({
        page: q.page,
        size: q.size,
        actor: q.actor,
        action: q.action,
        from: q.from,
        to: q.to,
        keyword: q.keyword,
      })
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async stats() {
    try {
      return Result.ok(this.dbService.auditStats())
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async actions() {
    try {
      const rows = this.dbService.getAdminDb()
        .prepare('SELECT action, count(*) AS c FROM audit_log GROUP BY action ORDER BY c DESC LIMIT 100')
        .all()
      return Result.ok(rows)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 通知中心：最近审计 + 失败登录，按时间倒序合并 */
  async feed(req) {
    try {
      const limit = Math.min(20, Number(req.query?.limit) || 8)
      const audits = this.dbService.getAdminDb()
        .prepare('SELECT id, actor, action, target, created_at FROM audit_log ORDER BY id DESC LIMIT ?')
        .all(limit)
      const fails = this.dbService.getAdminDb()
        .prepare('SELECT id, username, reason, created_at FROM login_log WHERE success = 0 ORDER BY id DESC LIMIT ?')
        .all(limit)
      const items = [
        ...audits.map((a) => ({
          id: `a-${a.id}`,
          kind: this._risky(a.action) ? 'risk' : 'audit',
          title: a.action,
          desc: `${a.actor || '-'} → ${a.target || '-'}`,
          time: a.created_at,
        })),
        ...fails.map((f) => ({
          id: `l-${f.id}`,
          kind: 'login',
          title: '登录失败',
          desc: `${f.username || '-'}：${f.reason || '密码错误'}`,
          time: f.created_at,
        })),
      ]
        .sort((x, y) => String(y.time).localeCompare(String(x.time)))
        .slice(0, limit)
      return Result.ok({list: items, unread: items.filter((i) => i.kind !== 'audit').length})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  _risky(action) {
    const a = String(action || '')
    return a.includes('delete') || a.includes('clear') || a.includes('quit') || a.includes('role')
  }

  async loginLog(req) {
    try {
      const q = req.query || {}
      return Result.ok(this.dbService.queryLoginLogPaged({
        page: q.page,
        size: q.size,
        username: q.username,
        success: q.success,
      }))
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
