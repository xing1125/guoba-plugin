import crypto from 'crypto'
import {autowired, Service} from '#guoba.framework'

/**
 * 后台 RBAC 认证服务：账号密码登录、角色管理、用户 CRUD。
 *
 * 与业务 AdminService 分离，只负责「后台管理自身」的认证与权限数据。
 * - 密码哈希：node:crypto.scrypt（不引入 bcrypt 依赖），格式 scrypt$N$r$p$salt$hash
 * - 角色：super 超管 / admin 管理员 / viewer 只读（builtin，不可删）
 * - 首次启动自动种子默认超管 admin（密码 admin，must_change=1 首登强制改密）
 *
 * 数据落 admin.db：admin_user / admin_role / login_log（表结构见 DbService.initSchema）。
 */

const BUILTIN_ROLES = [
  {
    role: 'super',
    name: '超级管理员',
    menus: ['*'],
    ops: ['*'],
    description: '拥有全部菜单与操作权限（含用户/角色管理与高危操作）',
  },
  {
    role: 'admin',
    name: '管理员',
    menus: [
      'home', 'dashboard', 'screen', 'sysinfo', 'files', 'miao-img', 'groups', 'users-data',
      'yingai', 'chat-diag', 'plugins-data', 'sign', 'data', 'config', 'account', 'uid', 'audit', 'logs', 'nav-mgr', 'about',
    ],
    ops: [
      'account:write',
      'data:write', 'data:delete',
      'group:write', 'group:delete',
      'plugin:write', 'config:write', 'config:delete',
      'audit:read',
    ],
    description: '除后台用户/角色管理、账号删除与系统重启外的全部权限',
  },
  {
    role: 'viewer',
    name: '只读成员',
    menus: ['*'],
    ops: [],
    description: '只可查看，不可执行任何写操作',
  },
]

const SCRYPT = {N: 16384, r: 8, p: 1, keylen: 32}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p}).toString('hex')
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [, N, r, p, salt, hash] = parts
    const calc = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {N: Number(N), r: Number(r), p: Number(p)}).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'))
  } catch {
    return false
  }
}

export class AuthService extends Service {

  dbService = autowired('dbService')
  permService = autowired('permService')

  get db() {
    return this.dbService
  }

  /* ----------------------------- 种子与初始化 ----------------------------- */

  /** 确保内置角色存在（幂等） */
  ensureRoles() {
    for (const r of BUILTIN_ROLES) {
      const exist = this.db.getRole(r.role)
      if (!exist) {
        this.db.upsertRole({...r, builtin: 1})
      }
    }
  }

  /** 确保默认超管存在（幂等）。首登强制改密 */
  ensureSuperAdmin() {
    this.ensureRoles()
    const admin = this.db.getUserByUsername('admin')
    if (!admin) {
      this.db.upsertUser({
        username: 'admin',
        password_hash: hashPassword('admin'),
        nickname: '超级管理员',
        role: 'super',
        status: 'active',
        must_change: 1,
      })
      logger?.info?.('[auth] 已创建默认超管账号 admin（初始密码 admin，请尽快登录修改）')
    }
  }

  /* ----------------------------- 登录 ----------------------------- */

  /**
   * 账号密码登录
   * @returns {{ok:boolean, user?:object, reason?:string}}
   */
  verifyLogin(username, password) {
    const name = String(username || '').trim()
    if (!name || !password) return {ok: false, reason: '用户名或密码不能为空'}
    const user = this.db.getUserByUsername(name)
    if (!user) return {ok: false, reason: '用户名或密码错误'}
    if (user.status !== 'active') return {ok: false, reason: '账号已被停用'}
    if (!verifyPassword(String(password), user.password_hash)) {
      return {ok: false, reason: '用户名或密码错误'}
    }
    return {ok: true, user}
  }

  /** 修改密码（校验旧密码） */
  changePassword(username, oldPwd, newPwd) {
    const user = this.db.getUserByUsername(String(username || '').trim())
    if (!user) throw new Error('用户不存在')
    if (!verifyPassword(String(oldPwd), user.password_hash)) throw new Error('旧密码不正确')
    if (!newPwd || String(newPwd).length < 6) throw new Error('新密码至少 6 位')
    this.db.upsertUser({
      id: user.id,
      username: user.username,
      password_hash: hashPassword(String(newPwd)),
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      must_change: 0,
    })
  }

  /* ----------------------------- 用户管理 ----------------------------- */

  listUsers(keyword) {
    return this.db.listUsers({keyword})
  }

  createUser({username, password, nickname = '', role = 'viewer'}) {
    const name = String(username || '').trim()
    if (!name) throw new Error('用户名不能为空')
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(name)) throw new Error('用户名需为 3-32 位字母/数字/下划线')
    if (this.db.getUserByUsername(name)) throw new Error('用户名已存在')
    if (!password || String(password).length < 6) throw new Error('密码至少 6 位')
    if (!this.db.getRole(role)) throw new Error(`角色不存在：${role}`)
    const user = this.db.upsertUser({
      username: name,
      password_hash: hashPassword(String(password)),
      nickname,
      role,
      status: 'active',
      must_change: 0,
    })
    const {password_hash, ...safe} = user
    return safe
  }

  updateUser(id, {nickname, role, status, password}) {
    const user = this.db.getUserById(id)
    if (!user) throw new Error('用户不存在')
    if (user.username === 'admin' && (status === 'disabled' || role !== 'super')) {
      throw new Error('内置超管 admin 不可停用或降级')
    }
    if (role && !this.db.getRole(role)) throw new Error(`角色不存在：${role}`)
    const patch = {
      id: user.id,
      username: user.username,
      password_hash: password ? hashPassword(String(password)) : user.password_hash,
      nickname: nickname ?? user.nickname,
      role: role ?? user.role,
      status: status ?? user.status,
      must_change: user.must_change,
    }
    if (password && String(password).length < 6) throw new Error('密码至少 6 位')
    const updated = this.db.upsertUser(patch)
    const {password_hash, ...safe} = updated
    return safe
  }

  deleteUser(id) {
    const user = this.db.getUserById(id)
    if (!user) throw new Error('用户不存在')
    if (user.username === 'admin') throw new Error('内置超管 admin 不可删除')
    this.db.deleteUser(id)
  }

  /* ----------------------------- 角色管理 ----------------------------- */

  listRoles() {
    return this.db.listRoles()
  }

  upsertRole({role, name, menus, ops, description}) {
    if (!role || !/^[a-zA-Z0-9_-]{2,32}$/.test(role)) throw new Error('角色标识需为 2-32 位字母/数字/下划线')
    const exist = this.db.getRole(role)
    if (exist?.builtin) throw new Error('内置角色不可修改')
    const saved = this.db.upsertRole({
      role,
      name: name || role,
      menus: Array.isArray(menus) ? menus : [],
      ops: Array.isArray(ops) ? ops : [],
      builtin: 0,
      description,
    })
    this.permService?.invalidate?.(role)
    return saved
  }

  deleteRole(role) {
    const exist = this.db.getRole(role)
    if (!exist) throw new Error('角色不存在')
    if (exist.builtin) throw new Error('内置角色不可删除')
    // 尚有用户引用则拒绝删除
    const users = this.db.listUsers({})
    if (users.some((u) => u.role === role)) throw new Error('该角色下仍有用户，请先调整用户角色')
    this.db.deleteRole(role)
    this.permService?.invalidate?.(role)
  }

  /** 菜单 / 操作码目录（角色编辑器用） */
  catalogue() {
    return this.permService?.catalogue?.() || {menus: [], ops: []}
  }
}

export {hashPassword, verifyPassword}
