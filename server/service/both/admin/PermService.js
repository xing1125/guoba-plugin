import {autowired, Service} from '#guoba.framework'

/**
 * 权限服务（RBAC 判定核心）
 *
 * 职责：
 *  1. 路由 → 操作码映射（scope 由路径前缀决定，verb 由 HTTP 方法决定）
 *  2. 角色 → 是否允许该操作码（角色 ops 列表，`*` / `scope:*` 为通配）
 *  3. 角色 → 可见菜单过滤（角色 menus 列表）
 *
 * 约定：
 *  - 只读请求（GET/HEAD）登录即可访问，页面可见性由菜单过滤控制；
 *  - 写请求必须命中的操作码，例如 account:delete / data:write / sys:write；
 *  - 自定义角色的 ops 存 JSON 数组，内置 super/admin 为 ['*']，viewer 为 []。
 */

/** 操作码目录（前端角色编辑器用） */
export const OP_CATALOGUE = [
  {group: '账号', items: [
    {op: 'account:write', name: '创建/编辑账号、UID 维护'},
    {op: 'account:delete', name: '删除账号（高危）'},
  ]},
  {group: '数据', items: [
    {op: 'data:write', name: 'Redis / 文件数据写入'},
    {op: 'data:delete', name: '删除 Redis 键 / 清理数据（高危）'},
  ]},
  {group: '群与插件', items: [
    {op: 'group:write', name: '设置群主/群管、AI 分群开关'},
    {op: 'group:delete', name: '清群数据 / 退群（高危）'},
    {op: 'plugin:write', name: '插件安装、卸载、配置修改'},
    {op: 'config:write', name: 'Bot 配置修改'},
    {op: 'config:delete', name: '删除配置卡'},
  ]},
  {group: '系统与权限', items: [
    {op: 'system:write', name: '系统操作（重启锅巴、建目录）'},
    {op: 'sys:write', name: '后台用户 / 角色管理'},
    {op: 'audit:read', name: '查看全量审计日志'},
  ]},
]

/** 菜单键（与 systemMenus.js 的 meta.perm 对应，供角色编辑器勾选） */
export const MENU_CATALOGUE = [
  {perm: 'home', name: '首页'},
  {perm: 'dashboard', name: '数据总览'},
  {perm: 'screen', name: '状态大屏'},
  {perm: 'sysinfo', name: '系统信息'},
  {perm: 'files', name: '文件管理'},
  {perm: 'miao-img', name: '喵喵面板图'},
  {perm: 'groups', name: '群数据'},
  {perm: 'users-data', name: '用户数据'},
  {perm: 'yingai', name: 'AI 私聊'},
  {perm: 'plugins-data', name: '插件数据'},
  {perm: 'sign', name: '游戏签到'},
  {perm: 'data', name: '数据管理'},
  {perm: 'config', name: '配置管理'},
  {perm: 'account', name: '账号管理'},
  {perm: 'uid', name: '游戏 UID'},
  {perm: 'sys-users', name: '后台用户'},
  {perm: 'audit', name: '审计日志'},
  {perm: 'logs', name: '运行日志'},
  {perm: 'about', name: '关于'},
]

/** 路径前缀 → 操作域 */
const SCOPE_RULES = [
  {re: /^\/api\/admin\/auth\//, scope: 'sys'},
  {re: /^\/api\/admin\/audit/, scope: 'audit'},
  {re: /^\/api\/admin\/logs/, scope: 'log'},
  {re: /^\/api\/admin\/accounts/, scope: 'account'},
  {re: /^\/api\/admin\/uids/, scope: 'account'},
  {re: /^\/api\/admin\/groups/, scope: 'group'},
  {re: /^\/api\/admin\/(data|files|redis)/, scope: 'data'},
  {re: /^\/api\/admin/, scope: 'data'},
  {re: /^\/api\/plugin/, scope: 'plugin'},
  {re: /^\/api\/config/, scope: 'config'},
  {re: /^\/api\/sys/, scope: 'system'},
  {re: /^\/api\/user/, scope: 'system'},
]

/** 免检写路由：登录即可执行（自助改密等） */
const SELF_WRITE_WHITELIST = [
  /^\/api\/admin\/auth\/password$/,
  /^\/api\/user\//,
]

/**
 * 高危路由覆盖：这些 POST 接口本质是删除/恢复类操作，
 * 单独归到 `xxx:delete` 操作码，避免「有写权限就能删」。
 */
const OP_OVERRIDES = [
  {re: /^\/api\/admin\/accounts\/(delete|delete-expired|restore)/, op: 'account:delete'},
  {re: /^\/api\/admin\/groups\/(batch-clear|quit)/, op: 'group:delete'},
  {re: /^\/api\/admin\/data\/(key\/delete|keys\/delete-prefix)/, op: 'data:delete'},
  {re: /^\/api\/admin\/logs\/clear/, op: 'log:delete'},
]

const CACHE_TTL = 10 * 1000

export class PermService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    /** role -> {ts, role} */
    this._roleCache = new Map()
  }

  /* ----------------------------- 操作码 ----------------------------- */

  /** 解析请求对应的操作码；只读请求返回 'read' */
  resolveOp(method, path) {
    const m = String(method || 'GET').toUpperCase()
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
      return 'read'
    }
    if (SELF_WRITE_WHITELIST.some((re) => re.test(path))) {
      return 'read'
    }
    for (const rule of OP_OVERRIDES) {
      if (rule.re.test(path)) {
        return rule.op
      }
    }
    let scope = 'data'
    for (const rule of SCOPE_RULES) {
      if (rule.re.test(path)) {
        scope = rule.scope
        break
      }
    }
    const verb = m === 'DELETE' ? 'delete' : 'write'
    return `${scope}:${verb}`
  }

  /* ----------------------------- 角色 ----------------------------- */

  _role(roleKey) {
    if (!roleKey) return null
    const hit = this._roleCache.get(roleKey)
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      return hit.role
    }
    let role = null
    try {
      role = this.dbService.getRole(roleKey)
    } catch {
      role = null
    }
    this._roleCache.set(roleKey, {ts: Date.now(), role})
    return role
  }

  /** 角色定义变更后立即失效缓存 */
  invalidate(roleKey) {
    if (roleKey) {
      this._roleCache.delete(roleKey)
    } else {
      this._roleCache.clear()
    }
  }

  /** 是否允许某操作码 */
  can(roleKey, op) {
    if (!op || op === 'read') return true
    const role = this._role(roleKey)
    if (!role) return false
    const ops = Array.isArray(role.ops) ? role.ops : []
    if (ops.includes('*') || ops.includes(op)) return true
    const scope = op.split(':')[0]
    return ops.includes(`${scope}:*`)
  }

  /**
   * 请求级判定
   * @returns {{ok:boolean, op:string, reason?:string}}
   */
  guard(reqUser, method, path) {
    if (!reqUser) return {ok: false, op: '', reason: '未登录'}
    const op = this.resolveOp(method, path)
    const roleKey = reqUser.role
    if (!this.can(roleKey, op)) {
      return {ok: false, op, reason: `当前角色无 ${op} 权限`}
    }
    return {ok: true, op}
  }

  /** 角色可见的操作码集合（前端渲染按钮用） */
  permsOf(roleKey) {
    const role = this._role(roleKey)
    const ops = Array.isArray(role?.ops) ? role.ops : []
    if (ops.includes('*')) {
      return ['*', ...OP_CATALOGUE.flatMap((g) => g.items.map((i) => i.op))]
    }
    return ops
  }

  /** 按角色过滤菜单 */
  filterMenus(menus, roleKey) {
    const role = this._role(roleKey)
    const allowed = Array.isArray(role?.menus) ? role.menus : []
    if (allowed.includes('*')) return menus
    return (menus || []).filter((m) => {
      const perm = m?.meta?.perm
      if (!perm) return true
      return allowed.includes(perm)
    })
  }

  /** 菜单/操作码目录（角色编辑器用） */
  catalogue() {
    return {menus: MENU_CATALOGUE, ops: OP_CATALOGUE}
  }
}
