import jwt from 'jsonwebtoken'
import {autowired, Interceptor, Result} from "#guoba.framework";
import {_paths, cfg, Constant} from "#guoba.platform";

// 弱令牌（只能用来访问静态资源等）
const liteInclude = [
  new RegExp('^/api/plugin/miao/help/theme/.+'),
]

// 需要拦截的路径
const include = [
  new RegExp('^/api/.*'),
  ...liteInclude,
]

// 不需要拦截的路径
const exclude = [
  new RegExp('^/api/login'),
  new RegExp('^/api/helper/transit'),
  new RegExp('^/api/helper/release_port'),
  new RegExp('^/api/plugin/s/.+/icon'),
]

/**
 * Token校验拦截器
 *
 * RBAC 升级后分两步：
 *   1. 校验 token → 注入 req.user（username / uid / role）
 *   2. 权限判定 → 路由映射操作码，角色不具备则 403
 *
 * 兼容：升级前签发的旧 token 只有 username，这里回查 admin_user 补齐 uid/role。
 *
 * @param app
 */
export default class TokenInterceptor extends Interceptor {

  systemService = autowired('systemService')
  authService = autowired('authService')
  permService = autowired('permService')

  constructor(app) {
    super(app)
  }

  async handler(req, res, next) {
    if (!include.find(reg => this.check(reg, req))) {
      next()
    } else if (exclude.find(reg => this.check(reg, req))) {
      next()
    } else {
      // 从query里获取token
      let token = req.query?.token
      if (!token) {
        token = req.headers[Constant.TOKEN_KEY]
      }
      if (token) {
        // 判断是否是弱令牌
        if (token.length === 8 && token === this.systemService.getLiteToken()) {
          if (liteInclude.find(reg => this.check(reg, req))) {
            next()
            return
          }
        } else {
          let redisKey = Constant.REDIS_PREFIX + 'access-token:' + token
          let redisToken = await redis.get(redisKey)
          if (redisToken) {
            try {
              const payload = jwt.verify(redisToken, cfg.getJwtSecret())
              const user = this._resolveUser(payload)
              // 注入当前登录用户（RBAC：uid/role/perms 供 Controller 做权限判断与审计）
              req.user = user
              const path = this.relativePath(req)
              const guard = this._guard(user, req.method, path)
              if (!guard.ok) {
                const result = Result.noAuth()
                result.message = guard.reason || '没有权限'
                res.status(result.httpStatus).json(result.toJSON())
                return
              }
              req.permOp = guard.op
              next()
              return
            } catch {
            }
          }
        }
      }
      let result = Result.noLogin()
      res.status(result.httpStatus).json(result.toJSON())
    }
  }

  /**
   * 还原登录用户：旧 token 只有 username，回查数据库补齐 uid/role，
   * 保证升级前的登录态不会因缺角色而被判定为无权限。
   */
  _resolveUser(payload) {
    if (!payload) return {username: 'admin', role: 'super'}
    if (typeof payload === 'string') {
      const row = this._lookup(payload)
      return {username: payload, uid: row?.id ?? null, role: row?.role ?? 'super'}
    }
    const user = {...payload}
    if (user.role == null || user.uid == null) {
      const row = this._lookup(user.username)
      if (row) {
        user.uid = row.id
        user.role = row.role
      } else {
        // 无对应后台账号（历史 token / 验证码通道）：按内置超管处理
        user.role = user.role ?? 'super'
      }
    }
    return user
  }

  _lookup(username) {
    if (!username) return null
    try {
      return this.authService?.db?.getUserByUsername?.(username) || null
    } catch {
      return null
    }
  }

  /** 权限判定：失败不影响主流程（服务异常时降级放行，靠 Controller 自行兜底） */
  _guard(user, method, path) {
    try {
      const permService = this.permService
      if (!permService?.guard) return {ok: true, op: 'read'}
      return permService.guard(user, method, path)
    } catch (e) {
      logger?.warn?.(`[Guoba] 权限判定异常，已降级放行：${e.message}`)
      return {ok: true, op: 'read'}
    }
  }

  /** 去掉自定义挂载前缀后的路径 */
  relativePath(req) {
    const {realMountPrefix} = _paths.server
    let {path} = req
    if (path.startsWith(realMountPrefix)) {
      path = path.substring(realMountPrefix.length)
    }
    return path
  }

  /**
   * 检查是否reg是否通过校验，兼容自定义前缀
   * @param {RegExp} reg
   * @param {Request} req
   */
  check(reg, req) {
    return reg.test(this.relativePath(req))
  }

  static priority = 100
}
