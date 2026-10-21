import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 荧（YingAI）心智观测接口
 *
 * GET /admin/yingmind/groups           有数据的群列表（附群名/记忆数/关系数/情绪）
 * GET /admin/yingmind/memories?gid=    某群记忆列表（按重要度降序）
 * GET /admin/yingmind/relations?gid=   某群关系列表 + 里程碑
 * GET /admin/yingmind/emotion?gid=     某群情绪快照
 */
export default class YingMindController extends ApiController {

  yingMindService = autowired('yingMindService')

  constructor(guobaApp) {
    super('/admin/yingmind', guobaApp)
  }

  registerRouters() {
    this.get('/groups', this.groups)
    this.get('/memories', this.memories)
    this.get('/relations', this.relations)
    this.get('/emotion', this.emotion)
  }

  async groups() {
    return Result.ok(this.yingMindService.groups())
  }

  async memories(req) {
    return Result.ok(this.yingMindService.memories(req.query?.gid))
  }

  async relations(req) {
    return Result.ok(this.yingMindService.relations(req.query?.gid))
  }

  async emotion(req) {
    return Result.ok(this.yingMindService.emotion(req.query?.gid))
  }
}
