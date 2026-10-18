import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'
import {sleep} from '#guoba.utils'

/**
 * 系统相关
 */
export class SystemController extends ApiController {

  systemService = autowired('systemService')
  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/sys', guobaApp)
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

  registerRouters() {
    this.post('/restart-guoba', this.doRestartGuoba)

    this.put('/fs/create-dir', this.putCreateDir)
    this.get('/fs/tree/root', this.getFsTreeRoot)
    this.get('/fs/tree/children', this.getFsTreeChildren)
  }

  async doRestartGuoba(req) {
    this._audit(req, 'system.restart', 'guoba')
    if (Guoba && Guoba.reload) {
      await Promise.any([Guoba.reload(), sleep(500)])
      return Result.ok({}, '锅巴重启成功~')
    } else {
      return Result.error({}, '锅巴服务异常，请手动重启！')
    }
  }

  async putCreateDir(req) {
    let {path, name} = req.body
    let result = await this.systemService.createDir(path, name)
    this._audit(req, 'system.mkdir', path + '/' + name)
    return Result.ok(result)
  }

  async getFsTreeRoot() {
    let result = await this.systemService.getFsTreeRoot()
    return Result.ok(result)
  }

  async getFsTreeChildren(req) {
    let {path} = req.query
    let result = await this.systemService.getFsTreeChildren(path)
    return Result.ok(result)
  }

}
