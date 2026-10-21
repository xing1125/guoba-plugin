import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 后台控制台接口
 *
 * GET  /admin/console/status            Bot 在线状态与目标数
 * GET  /admin/console/targets          群/好友列表（?kind=group&keyword=）
 * POST /admin/console/send             以 Bot 身份发消息 {kind,id,text}
 * POST /admin/console/exec             模拟执行指令 {kind,id,cmd,deliver,asOwner,confirm}
 * GET  /admin/console/history          最近记录（?limit=30）
 */
export default class ConsoleController extends ApiController {

  consoleService = autowired('consoleService')

  constructor(guobaApp) {
    super('/admin/console', guobaApp)
  }

  registerRouters() {
    this.get('/status', this.status)
    this.get('/targets', this.targets)
    this.post('/send', this.send)
    this.post('/exec', this.exec)
    this.get('/history', this.history)
  }

  async status() {
    return Result.ok(await this.consoleService.status())
  }

  async targets(req) {
    const kind = String(req.query?.kind || 'group')
    const keyword = String(req.query?.keyword || '')
    try {
      return Result.ok(await this.consoleService.targets(kind, keyword))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async send(req) {
    const {kind, id, text} = req.body || {}
    try {
      const data = await this.consoleService.send({kind, id, text})
      return Result.ok(data, '发送成功')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async exec(req) {
    const {kind, id, cmd, deliver, asOwner, confirm, timeout} = req.body || {}
    try {
      const data = await this.consoleService.exec({
        kind,
        id,
        cmd,
        deliver: deliver === true || deliver === 'true',
        asOwner: asOwner !== false && asOwner !== 'false',
        confirm: confirm === true || confirm === 'true',
        timeout: Number(timeout) || 15000,
      })
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async history(req) {
    const limit = Number(req.query?.limit) || 30
    return Result.ok(await this.consoleService.history(limit))
  }
}
