import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 数据可视化接口（插件数据 / 群数据）
 *
 * 全部只读，全部来自 Redis 聚合，带内存缓存。
 */
export default class StatsController extends ApiController {

  statsService = autowired('statsService')

  constructor(guobaApp) {
    super('/admin/stats', guobaApp)
  }

  registerRouters() {
    this.get('/overview', this.overview)
    this.get('/plugins', this.plugins)
    this.get('/groups', this.groups)
    this.get('/group/:gid', this.groupDetail)
    this.get('/trend', this.trend)
    this.get('/games', this.games)
    this.get('/users', this.users)
    this.get('/user-hero', this.userHero)
    this.get('/user/:uid', this.userDetail)
    this.get('/runtime', this.runtime)
  }

  /** 用户统计页 hero 聚合 */
  async userHero(req) {
    const err = await this._guard()
    if (err) return err
    const force = String(req.query?.force || '') === 'true'
    const data = await this.statsService.getUserHero(force)
    return Result.ok(data)
  }

  async _guard() {
    if (!globalThis.redis) {
      return Result.error('Redis 未就绪，请确认 Bot 已正常启动')
    }
    return null
  }

  /** 顶部统计卡：Redis 键数、命名空间数、群数、今日消息、累计消息 */
  async overview() {
    const err = await this._guard()
    if (err) return err
    const data = await this.statsService.getOverviewCards()
    return Result.ok(data)
  }

  /** 机器人本体运行状态（状态大屏用，CPU 占用为两次请求间采样差值） */
  async runtime() {
    const data = await this.statsService.getRuntime()
    return Result.ok(data)
  }

  /** 插件命名空间直方图 */
  async plugins(req) {
    const err = await this._guard()
    if (err) return err
    const force = String(req.query?.force || '') === '1'
    const data = await this.statsService.getHistogram(force)
    return Result.ok(data)
  }

  /** 群列表（分页 + 搜索 + 排序） */
  async groups(req) {
    const err = await this._guard()
    if (err) return err
    const {keyword, sort, order, page, size} = req.query || {}
    const data = await this.statsService.queryGroups({
      keyword: keyword ? String(keyword).trim() : '',
      sort: sort ? String(sort) : 'total',
      order: order ? String(order) : 'desc',
      page: Number(page) || 1,
      size: Number(size) || 20,
    })
    return Result.ok(data)
  }

  /** 单群详情 */
  async groupDetail(req) {
    const err = await this._guard()
    if (err) return err
    const gid = decodeURIComponent(String(req.params?.gid || ''))
    if (!gid) return Result.error('群号不合法')
    const data = await this.statsService.getGroupDetail(gid)
    if (!data.available) return Result.error(`未找到群 ${gid} 的统计数据`)
    return Result.ok(data)
  }

  /** 消息趋势 */
  async trend(req) {
    const err = await this._guard()
    if (err) return err
    const days = Number(req.query?.days) || 14
    const data = await this.statsService.getTrend(days)
    return Result.ok(data)
  }

  /** 游戏维度分布（缓存 / 档案） */
  async games() {
    const err = await this._guard()
    if (err) return err
    const data = await this.statsService.getGameDistribution()
    return Result.ok(data)
  }

  /** 用户列表（分页 + 搜索 + 排序） */
  async users(req) {
    const err = await this._guard()
    if (err) return err
    const {keyword, sort, order, page, size} = req.query || {}
    const data = await this.statsService.queryUsers({
      keyword: keyword ? String(keyword).trim() : '',
      sort: sort ? String(sort) : 'total',
      order: order ? String(order) : 'desc',
      page: Number(page) || 1,
      size: Number(size) || 20,
    })
    return Result.ok(data)
  }

  /** 单用户详情 */
  async userDetail(req) {
    const err = await this._guard()
    if (err) return err
    const uid = decodeURIComponent(String(req.params?.uid || ''))
    if (!uid) return Result.error('用户 ID 不合法')
    const data = await this.statsService.getUserDetail(uid)
    if (!data.available) return Result.error(`未找到用户 ${uid} 的统计数据`)
    return Result.ok(data)
  }
}
