import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 统一告警中心接口
 *
 * GET /admin/alert-center/list   聚合签到/插件/系统三源告警
 */
export default class AlertCenterController extends ApiController {

  alertCenterService = autowired('alertCenterService')

  constructor(guobaApp) {
    super('/admin/alert-center', guobaApp)
  }

  registerRouters() {
    this.get('/list', this.list)
  }

  async list() {
    return Result.ok(await this.alertCenterService.list())
  }
}
