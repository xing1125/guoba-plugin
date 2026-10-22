import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 群战力榜接口（只读）
 *
 *   GET /admin/rank/groups          有排行数据的群 + 各类型角色数
 *   GET /admin/rank/board?gid=&type=&charId=&limit=
 *   GET /admin/rank/overview        每群体量总览（跨群横向对比）
 *   GET /admin/rank/char-usage?type=&game=&limit=
 *   GET /admin/rank/compare?type=&charId=
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
    this.get('/overview', this.overview)
    this.get('/char-usage', this.charUsage)
    this.get('/compare', this.compare)
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

  async overview(req) {
    const err = await this._guard()
    if (err) return err
    const force = String(req.query?.force || '') === 'true'
    return Result.ok(await this.rankService.overview({force}))
  }

  async charUsage(req) {
    const err = await this._guard()
    if (err) return err
    const {type = 'dmg', game = '', limit, force} = req.query || {}
    const data = await this.rankService.charUsage({
      type: String(type),
      game: String(game || ''),
      limit: Number(limit) || 30,
      force: String(force || '') === 'true',
    })
    return Result.ok(data)
  }

  async compare(req) {
    const err = await this._guard()
    if (err) return err
    const {type = 'dmg', charId = ''} = req.query || {}
    const data = await this.rankService.compareGroups({
      type: String(type),
      charId: String(charId || ''),
    })
    return Result.ok(data)
  }
}
