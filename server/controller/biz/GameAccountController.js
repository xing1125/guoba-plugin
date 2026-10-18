import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 游戏账号接口（用户统计页的游戏绑定矩阵 + 账号页的游戏维度明细）
 *
 *  GET /api/admin/games/overview            各游戏绑定概览（含鸣潮）
 *  GET /api/admin/games/:game/accounts      某游戏的账号明细（含 UID/昵称/CK/SK 标记）
 *  GET /api/admin/games/stoken/report        Stoken 状态明细（来自 Lotus 档案，只读）
 */
export default class GameAccountController extends ApiController {

  gameAccountService = autowired('gameAccountService')

  constructor(guobaApp) {
    super('/admin/games', guobaApp)
  }

  registerRouters() {
    this.get('/overview', this.overview)
    this.get('/stoken/report', this.stokenReport)
    this.get('/:game/accounts', this.accounts)
  }

  async overview(req) {
    try {
      const force = String(req.query?.force || '') === 'true'
      return Result.ok(await this.gameAccountService.overview(force))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async accounts(req) {
    try {
      const game = String(req.params?.game || '').trim()
      const q = String(req.query?.q || '')
      return Result.ok(await this.gameAccountService.accounts(game, {q}))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async stokenReport(req) {
    try {
      const game = String(req.query?.game || '').trim()
      return Result.ok(await this.gameAccountService.stokenReport(game))
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
