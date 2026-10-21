import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 群战力榜接口（只读）
 *
 *   GET /admin/rank/groups          有排行数据的群 + 各类型角色数
 *   GET /admin/rank/board?gid=&type=&charId=&limit=
 *
 * 数据全部来自 miao-plugin 写在 Redis 里的 zset，不改动插件本身。
 */
export default class RankController extends ApiController {

  rankService = autowired('rankService')

  constructor(guobaApp) {
    super('/admin/rank', guobaApp)
  }

  registerRouters() {
    this.get('/groups', this.groups)
    this.get('/board', this.board)
  }

  async _guard() {
    if (!globalThis.redis) {
      return Result.error('Redis 未就绪，请确认 Bot 已正常启动')
    }
    return null
  }

  async groups(req) {
    const err = await this._guard()
    if (err) return err
    const force = String(req.query?.force || '') === 'true'
    return Result.ok(await this.rankService.listGroups(force))
  }

  async board(req) {
    const err = await this._guard()
    if (err) return err
    const {gid = '', type = 'dmg', charId = '', limit} = req.query || {}
    if (!gid) {
      return Result.error('缺少群号（gid）')
    }
    const data = await this.rankService.board({
      gid: String(gid),
      type: String(type),
      charId: String(charId || ''),
      limit: Number(limit) || 20,
    })
    return Result.ok(data)
  }
}
