import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 导航管理接口（菜单显隐 / 排序偏好）
 * 全部只影响后台 UI，不动 RBAC。
 */
export default class MenuPrefsController extends ApiController {

  menuPrefsService = autowired('menuPrefsService')

  constructor(guobaApp) {
    super('/admin/menus', guobaApp)
  }

  registerRouters() {
    this.get('/prefs', this.getPrefs)
    this.put('/prefs', this.setPrefs)
  }

  async getPrefs() {
    return Result.ok(await this.menuPrefsService.getPrefs())
  }

  async setPrefs(req) {
    const body = req.body || {}
    const saved = await this.menuPrefsService.setPrefs(
      {hidden: body.hidden, order: body.order},
      {
        actor: String(req.user?.username || ''),
        ip: String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      },
    )
    return Result.ok(saved)
  }
}
