import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

export class PermissionController extends ApiController {

  systemService = autowired('systemService')
  permService = autowired('permService')

  constructor(guobaApp) {
    super('', guobaApp)
  }

  registerRouters() {
    this.get('/getPermCode', this.getPermCode)
    this.get('/getMenuList', this.getMenuList)
  }

  // 获取用户权限（RBAC：返回角色操作码，前端按此禁用写操作按钮）
  async getPermCode(req) {
    const role = req.user?.role || 'super'
    let ops = []
    try {
      ops = this.permService?.permsOf?.(role) || []
    } catch {
      ops = []
    }
    return Result.ok({
      permCode: ops,
      role,
      liteToken: this.systemService.getLiteToken(),
    })
  }

  // 菜单按角色过滤
  async getMenuList(req) {
    let menus = await this.systemService.queryMenus()
    try {
      const role = req.user?.role || 'super'
      menus = this.permService?.filterMenus?.(menus, role) || menus
    } catch (e) {
      logger?.warn?.(`[Guoba] 菜单过滤失败，返回全量：${e.message}`)
    }
    return Result.ok(menus)
  }
}
