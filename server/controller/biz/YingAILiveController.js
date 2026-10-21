import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 荧（YingAI）实时对话接口
 *
 * GET /admin/yingai-live/stream?after=<ts>&gid=&limit=  增量拉取实时对话流
 * GET /admin/yingai-live/groups                         有实时流的群列表（按活跃排序）
 * POST /admin/yingai-live/reply                         以 Bot 身份代发 {gid, text}
 */
export default class YingAILiveController extends ApiController {

  yingAiLiveService = autowired('yingAiLiveService')

  constructor(guobaApp) {
    super('/admin/yingai-live', guobaApp)
  }

  registerRouters() {
    this.get('/stream', this.stream)
    this.get('/groups', this.groups)
    this.post('/reply', this.reply)
  }

  async stream(req) {
    const after = Number(req.query?.after) || 0
    const gid = String(req.query?.gid || '')
    const limit = Number(req.query?.limit) || 200
    return Result.ok(this.yingAiLiveService.stream({after, gid, limit}))
  }

  async groups() {
    return Result.ok(this.yingAiLiveService.groups())
  }

  async reply(req) {
    const {gid, text} = req.body || {}
    try {
      const data = await this.yingAiLiveService.reply({gid, text})
      return Result.ok(data, '已发送')
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
