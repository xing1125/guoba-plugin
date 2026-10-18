import jwt from 'jsonwebtoken'
import {autowired, GuobaError, Service} from '#guoba.framework';
import {cfg, Constant} from "#guoba.platform";
import {getAllWebAddress, randomString} from '#guoba.utils'

export class LoginService extends Service {

  authService = autowired('authService')

  constructor(app) {
    super(app)
  }

  /** 注册并保存Token。identity 可为字符串（兼容旧逻辑）或 {username, uid, role} */
  signToken(identity) {
    let payload
    if (typeof identity === 'string') {
      payload = {username: identity}
    } else {
      payload = {
        username: identity?.username,
        uid: identity?.uid ?? identity?.id ?? null,
        role: identity?.role ?? null,
      }
    }
    let token = jwt.sign(payload, cfg.getJwtSecret())
    // 将token存入redis
    let redisKey = this.getRedisKey(token)
    redis.set(redisKey, token, {EX: 3600 * 24})
    return token
  }

  logout(token) {
    if (token) {
      let redisKey = this.getRedisKey(token)
      redis.del(redisKey)
    }
  }

  /**
   * 账号密码登录（RBAC）。成功返回 {token, user}；失败返回 {ok:false, reason}。
   * 登录日志 + 失败限流（同一用户名 5 次/5 分钟锁定）。
   */
  async passwordLogin({username, password, ip = '', ua = ''}) {
    const name = String(username || '').trim()
    const failKey = `${Constant.REDIS_PREFIX}login-fail:${name}`

    // 失败限流：5 次/5 分钟
    let failCount = 0
    try {
      failCount = Number(await redis.get(failKey)) || 0
    } catch {}
    if (failCount >= 5) {
      this.authService?.db?.writeLoginLog?.({username: name, ip, ua, success: false, reason: '失败次数过多，已临时锁定'})
      return {ok: false, reason: '失败次数过多，请 5 分钟后再试'}
    }

    const res = this.authService?.verifyLogin?.(name, password)
    if (!res || !res.ok) {
      try { await redis.set(failKey, String(failCount + 1), {EX: 300}) } catch {}
      this.authService?.db?.writeLoginLog?.({username: name, ip, ua, success: false, reason: res?.reason || '用户名或密码错误'})
      return {ok: false, reason: res?.reason || '用户名或密码错误'}
    }

    // 成功：清空失败计数 + 登录日志 + 更新最后登录时间
    try { await redis.del(failKey) } catch {}
    const user = res.user
    this.authService?.db?.writeLoginLog?.({username: name, ip, ua, success: true})
    this.authService?.db?.updateUserMeta?.(user.id, {last_login_at: new Date().toISOString()})

    const token = this.signToken({username: user.username, uid: user.id, role: user.role})
    return {
      ok: true,
      token,
      user: {
        username: user.username,
        nickname: user.nickname,
        role: user.role,
        mustChange: !!user.must_change,
      },
    }
  }

  async setQuickLogin(username) {
    let {redisKey, code} = this.getQuickLoginRedisKey(null)
    let token = this.signToken(username)
    redis.set(redisKey, token, {EX: 180})
    let webAddress = await getAllWebAddress()
    for (let [key, address] of Object.entries(webAddress)) {
      webAddress[key] = address.map(h => `${h}/#/ml/${code}`)
    }
    return webAddress
  }

  async getQuickLogin(code) {
    if (!code) {
      throw new GuobaError('登录失败')
    }
    let {redisKey} = this.getQuickLoginRedisKey(code)
    let token = await redis.get(redisKey)
    if (token) {
      redis.del(redisKey)
      return {token}
    }
    throw new GuobaError('登录失败')
  }

  getQuickLoginRedisKey(code) {
    if (!code) {
      code = randomString(6)
    }
    return {
      code,
      redisKey: `${Constant.REDIS_PREFIX}login-quick:${code}`,
    }
  }

  async codeLoginRequest() {
    let redisKey = `${Constant.REDIS_PREFIX}login-code`
    let code = await redis.get(redisKey)
    if (code) {
      throw new GuobaError('当前验证码还未失效，请稍后再试')
    } else {
      code = randomString(16)
    }
    await redis.set(redisKey, code, {EX: 300})
    return code
  }

  async codeLoginCheck(code) {
    if (!code || typeof code !== 'string') {
      return false
    }
    let redisKey = `${Constant.REDIS_PREFIX}login-code`
    let redisCode = await redis.get(redisKey)
    if (!redisCode) {
      return false
    }
    if (redisCode === code) {
      await redis.del(redisKey)
      // 验证码通道映射到内置超管（兼容旧行为），并注入 uid/role
      const admin = this.authService?.db?.getUserByUsername?.('admin')
      return await this.signToken({username: 'admin', uid: admin?.id ?? null, role: admin?.role ?? 'super'})
    }
    return false
  }

  getRedisKey(token) {
    return `${Constant.REDIS_PREFIX}access-token:${token}`
  }
}
