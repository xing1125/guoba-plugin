import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

export class UserController extends ApiController {
  authService = autowired('authService')

  constructor(guobaApp) {
    super('/user', guobaApp)
  }

  registerRouters() {
    this.get('/getLoginUser', this.getLoginUser)
  }

  // 获取登录用户（RBAC：从 JWT 注入的 req.user 还原角色）
  async getLoginUser(req) {
    const u = req.user || {}
    let role = u.role || 'sa'
    let nickname = '超级管理员'
    let username = u.username || String(Bot?.uin ?? '')
    // 有 uid 时读 admin_user 拿最新昵称/角色
    if (u.uid != null) {
      const row = this.authService?.db?.getUserById?.(u.uid)
      if (row) {
        role = row.role || role
        nickname = row.nickname || nickname
        username = row.username || username
      }
    }
    // vben 前端角色枚举（src/enums/roleEnum.ts）：SUPER='super'
    const roleMap = {super: 'super', admin: 'admin', viewer: 'viewer'}
    const frontRole = roleMap[role] || 'viewer'
    const roleNameMap = {super: '超级管理员', admin: '管理员', viewer: '只读成员'}
    return Result.ok({
      userId: username,
      username,
      realName: nickname,
      avatar: '',
      desc: roleNameMap[role] || role,
      homePath: '/home',
      roles: [
        {roleName: roleNameMap[role] || role, value: frontRole},
      ],
      role,
    })
  }
}