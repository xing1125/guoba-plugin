import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

export default class ConfigController extends ApiController {

  configService = autowired('configServiceImpl')
  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/config', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/tabs', this.tabs)
    this.get('/data', this.getData)
    this.post('/data', this.setData)
    this.delete('/card-Form', this.removeCardForm)
    this.get('/versions', this.versions)
    this.get('/version', this.version)
    this.get('/diff', this.diff)
    this.post('/restore', this.restore)
    this.get('/export', this.exportConfig)
    this.post('/import', this.importConfig)
  }

  /* ------------------------------ 写接口守卫 ------------------------------ */

  /** 危险操作二次确认：body.confirm 必须为 true */
  _confirmed(req) {
    return req.body?.confirm === true
  }

  /** 简易限流：同一 action 在 windowMs 内最多 times 次 */
  _rateLimit(req, action, times = 10, windowMs = 60_000) {
    const key = `${action}:${req.ip || req.socket?.remoteAddress || 'unknown'}`
    const now = Date.now()
    const list = (this._hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= times) return false
    list.push(now)
    this._hits.set(key, list)
    return true
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

  /* ------------------------------ 版本 / 对比 / 导出导入 ------------------------------ */

  async versions(req) {
    try {
      return Result.ok(this.configService.listVersions(req.query?.key))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async version(req) {
    try {
      const {key, file} = req.query || {}
      return Result.ok(this.configService.readVersion(key, file))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async diff(req) {
    try {
      const {key, file} = req.query || {}
      return Result.ok(this.configService.diffVersion(key, file))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async restore(req) {
    const {key, file} = req.body || {}
    if (!this._confirmed(req)) return Result.error('缺少二次确认（confirm）')
    if (!this._rateLimit(req, 'cfgRestore', 10)) return Result.error('操作过于频繁，稍后再试')
    try {
      const data = await this.configService.restoreVersion(key, file)
      this._audit(req, 'config.restore', key,
        `回滚到 ${file}，回滚前备份 ${data.backupOf || '无'}${data.hot === false ? `，需重启：${data.reason}` : ''}`)
      return Result.ok(data, data.hot === false ? '已回滚，需重启生效' : '已回滚')
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async exportConfig(req) {
    try {
      return Result.ok(this.configService.exportConfig(req.query?.key))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async importConfig(req) {
    const {key, content} = req.body || {}
    if (!this._confirmed(req)) return Result.error('缺少二次确认（confirm）')
    if (!this._rateLimit(req, 'cfgImport', 10)) return Result.error('操作过于频繁，稍后再试')
    try {
      const data = await this.configService.importConfig(key, content)
      this._audit(req, 'config.import', key,
        `导入 ${data.bytes} 字节，导入前备份 ${data.backupOf || '无'}${data.hot === false ? `，需重启：${data.reason}` : ''}`)
      return Result.ok(data, data.hot === false ? '已导入，需重启生效' : '已导入')
    } catch (e) {
      return Result.error(e.message)
    }
  }

}
