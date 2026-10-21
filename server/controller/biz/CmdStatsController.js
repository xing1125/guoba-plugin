import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 指令使用统计接口
 *
 * GET /admin/cmd-stats/list?days=7   最近 N 天指令/群/用户/插件排行
 */
export default class CmdStatsController extends ApiController {

  cmdStatsService = autowired('cmdStatsService')

  constructor(guobaApp) {
    super('/admin/cmd-stats', guobaApp)
  }

  registerRouters() {
    this.get('/list', this.list)
  }

  async list(req) {
    return Result.ok(await this.cmdStatsService.list({days: req.query?.days}))
  }
}
