import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * RBAC 用户 / 角色管理接口（挂在 /api/admin/auth 下，复用 TokenInterceptor 鉴权）。
 * 写操作均落审计（actor 取 req.user.username）。
 */
export class AuthController extends ApiController {

  authService = autowired('authService')
  loginService = autowired('loginService')

  constructor(guobaApp) {
    super('/admin/auth', guobaApp)
  }

  registerRouters() {
    // 用户
    this.get('/users', this.listUsers)
    this.post('/users', this.createUser)
    this.post('/users/:id', this.updateUser)
    this.delete('/users/:id', this.deleteUser)
    // 角色
    this.get('/roles', this.listRoles)
    this.post('/roles', this.upsertRole)
    this.delete('/roles/:role', this.deleteRole)
    // 菜单 / 操作码目录
    this.get('/catalogue', this.catalogue)
    // 改密
    this.post('/password', this.changePassword)
    // 登录日志
    this.get('/login-log', this.loginLog)
    // 移动端访问链接（复刻 #锅巴登录 快捷通道）
    this.post('/quick-link', this.quickLink)
  }

  _actor(req) {
    return req.user?.username || ''
  }

  async listUsers() {
    try {
      return Result.ok(this.authService.listUsers())
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async createUser(req) {
    try {
      const user = this.authService.createUser(req.body || {})
      this._audit(req, 'auth:create-user', user.username)
      return Result.ok(user)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async updateUser(req) {
    try {
      const user = this.authService.updateUser(req.params?.id, req.body || {})
      this._audit(req, 'auth:update-user', user.username)
      return Result.ok(user)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async deleteUser(req) {
    try {
      const id = req.params?.id
      const target = this.authService.db?.getUserById?.(id)
      this.authService.deleteUser(id)
      this._audit(req, 'auth:delete-user', target?.username || String(id))
      return Result.ok('删除成功')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async listRoles() {
    try {
      return Result.ok(this.authService.listRoles())
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async upsertRole(req) {
    try {
      const role = this.authService.upsertRole(req.body || {})
      this._audit(req, 'auth:upsert-role', role.role)
      return Result.ok(role)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async deleteRole(req) {
    try {
      const role = decodeURIComponent(String(req.params?.role || ''))
      this.authService.deleteRole(role)
      this._audit(req, 'auth:delete-role', role)
      return Result.ok('删除成功')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async changePassword(req) {
    try {
      const {oldPassword, newPassword} = req.body || {}
      const username = this._actor(req)
      this.authService.changePassword(username, oldPassword, newPassword)
      this._audit(req, 'auth:change-password', username)
      return Result.ok('密码修改成功')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async loginLog(req) {
    try {
      const q = req.query || {}
      if (q.page || q.size) {
        return Result.ok(this.authService.db?.queryLoginLogPaged?.({
          page: q.page,
          size: q.size,
          username: q.username,
          success: q.success,
        }) || {list: [], total: 0})
      }
      const limit = Number(q.limit) || 50
      return Result.ok(this.authService.db?.queryLoginLog?.({limit}) || [])
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 生成移动端访问链接（与 #锅巴登录 同通道，快捷码 180s 有效，token 24h） */
  async quickLink(req) {
    try {
      const username = this._actor(req) || 'admin'
      const webAddress = await this.loginService.setQuickLogin(username)
      // webAddress: { 网络名: [ 'http://ip:port/guoba/#/ml/code', ... ] }
      const links = []
      for (const urls of Object.values(webAddress || {})) {
        for (const u of urls || []) {
          if (!links.includes(u)) links.push(u)
        }
      }
      this._audit(req, 'auth:quick-link', username)
      return Result.ok({links, expiresIn: 180})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async catalogue() {
    try {
      return Result.ok(this.authService.catalogue())
    } catch (e) {
      return Result.error(e.message)
    }
  }

  _audit(req, action, target) {
    try {
      this.authService.db?.writeAudit?.({
        actor: this._actor(req),
        action,
        target,
        ip: (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim(),
      })
    } catch {
      /* 审计失败不阻断主流程 */
    }
  }
}
