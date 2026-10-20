import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

export default class ConfigController extends ApiController {

  configService = autowired('configServiceImpl')
  dbService = autowired('dbService')
  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/config', guobaApp)
  }

  registerRouters() {
    this.get('/tabs', this.tabs)
    this.get('/data', this.getData)
    this.post('/data', this.setData)
    this.delete('/card-Form', this.removeCardForm)
  }

  /** 写审计 */
  _audit(req, action, target, detail) {
    try {
      this.dbService?.writeAudit?.({
        actor: String(req.user?.username || ''),
        action,
        target: String(target ?? ''),
        detail: detail ?? '',
        ip: String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      })
    } catch {
      /* 审计失败不阻断主流程 */
    }
  }

  async tabs() {
    let config = await this.configService.getConfigTabs()
    return Result.ok(config)
  }

  async getData(req) {
    let {key} = req.query
    let data = await this.configService.getConfigData(key)
    return Result.ok(data)
  }

  async setData(req) {
    let {key, data} = req.body
    let res = await this.configService.setConfigData(key, data)
    this._audit(req, 'config.save', key, res?.hot === false ? `需重启：${res.reason}` : '已热更新')
    return Result.ok({message: '保存成功~', ...(res || {})})
  }

  async removeCardForm(req) {
    let {formKey, cardKey} = req.body
    await this.configService.removeCardForm(formKey, cardKey)
    this._audit(req, 'config.remove-card', formKey + '/' + cardKey)
    return Result.ok('删除成功~')
  }

}
