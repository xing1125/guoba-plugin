import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 插件健康度接口
 *
 * GET /admin/plugin-health/list   全量插件健康列表（加载状态/类数/数据体积）
 */
export default class PluginHealthController extends ApiController {

  pluginHealthService = autowired('pluginHealthService')

  constructor(guobaApp) {
    super('/admin/plugin-health', guobaApp)
  }

  registerRouters() {
    this.get('/list', this.list)
  }

  async list() {
    return Result.ok(await this.pluginHealthService.list())
  }
}
