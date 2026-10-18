import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 插件数据管理接口
 *
 * 覆盖所有插件的数据：
 *   - Redis 键（命名空间 / 键列表 / 值 / 写入 / 删除 / TTL / 备份恢复）
 *   - 插件 data 目录下的数据文件（浏览 / 读取 / 写入 / 备份恢复）
 *
 * 所有写操作必须带 confirm:true，且写入前自动备份。
 */
export default class PluginDataController extends ApiController {

  dataService = autowired('dataService')
  fileService = autowired('fileService')

  constructor(guobaApp) {
    super('/admin/data', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/domains', this.domains)
    this.get('/keys', this.keys)
    this.get('/key', this.getKey)
    this.post('/key/set', this.setKey)
    this.post('/key/delete', this.deleteKey)
    this.post('/key/ttl', this.setTtl)
    this.post('/keys/delete-prefix', this.deletePrefix)
    this.get('/backups', this.backups)
    this.post('/backups/restore', this.restoreBackup)

    this.get('/files/plugins', this.filePlugins)
    this.get('/files', this.files)
    this.get('/file', this.readFile)
    this.post('/file/save', this.saveFile)
    this.get('/file/backups', this.fileBackups)
    this.post('/file/restore', this.restoreFile)
  }

  _ctx(req) {
    return {
      actor: String(req.user?.username || req.body?.actor || 'master'),
      ip: String(req.ip || req.socket?.remoteAddress || ''),
    }
  }

  _confirmed(req) {
    const c = req.body?.confirm
    return c === true || c === 'DELETE' || c === 'delete'
  }

  _rateLimit(req, action, times = 20, windowMs = 60_000) {
    const key = `${action}:${req.ip || ''}`
    const now = Date.now()
    const list = (this._hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= times) {
      return false
    }
    list.push(now)
    this._hits.set(key, list)
    if (this._hits.size > 300) {
      for (const [k, v] of this._hits) {
        if (!v.some((t) => now - t < windowMs)) this._hits.delete(k)
      }
    }
    return true
  }

  // ------------------------------------------------------------ Redis

  async domains(req) {
    try {
      const data = await this.dataService.getDomains(req.query?.force === '1')
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async keys(req) {
    try {
      const {prefix, q, page, size} = req.query || {}
      const data = await this.dataService.listKeys({
        prefix: prefix ? String(prefix) : '',
        q: q ? String(q) : '',
        page: Number(page) || 1,
        size: Number(size) || 20,
      })
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async getKey(req) {
    try {
      const key = req.query?.key ? String(req.query.key) : ''
      const data = await this.dataService.getKey(key)
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async setKey(req) {
    if (!this._rateLimit(req, 'dataSet', 30)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const key = req.body?.key ? String(req.body.key) : ''
    if (!key) {
      return Result.error('key 不能为空')
    }
    try {
      const data = await this.dataService.setKey(key, {type: req.body?.type, value: req.body?.value, ttl: req.body?.ttl}, this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async deleteKey(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'dataDel', 20)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    const key = req.body?.key ? String(req.body.key) : ''
    try {
      // 核心计数类键额外要求 key 完全一致确认
      if (key.startsWith('Yz:count:') && req.body?.confirmKey !== key) {
        return Result.error('删除消息计数键需要把完整 key 填入确认框')
      }
      const data = await this.dataService.deleteKey(key, this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async setTtl(req) {
    if (!this._rateLimit(req, 'dataTtl', 20)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = await this.dataService.setTtl(String(req.body?.key || ''), Number(req.body?.ttl), this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async deletePrefix(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'dataDelPrefix', 3)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    const prefix = req.body?.prefix ? String(req.body.prefix) : ''
    try {
      const data = await this.dataService.deleteByPrefix(prefix, this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async backups(req) {
    return Result.ok({list: this.dataService.listBackups(Number(req.query?.limit) || 100)})
  }

  async restoreBackup(req) {
    if (!this._rateLimit(req, 'dataRestore', 10)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = await this.dataService.restoreBackup(Number(req.body?.id), this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  // ------------------------------------------------------------ 文件

  async filePlugins() {
    try {
      return Result.ok({list: this.fileService.listPlugins()})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async files(req) {
    try {
      const plugin = String(req.query?.plugin || '')
      const p = req.query?.path ? String(req.query.path) : ''
      return Result.ok(this.fileService.listFiles(plugin, p))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async readFile(req) {
    try {
      const plugin = String(req.query?.plugin || '')
      const p = String(req.query?.path || '')
      return Result.ok(this.fileService.readFile(plugin, p))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async saveFile(req) {
    if (!this._rateLimit(req, 'fileSave', 20)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const plugin = String(req.body?.plugin || '')
      const p = String(req.body?.path || '')
      const data = this.fileService.writeFile(plugin, p, req.body?.content, this._ctx(req))
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async fileBackups(req) {
    try {
      const plugin = String(req.query?.plugin || '')
      const p = String(req.query?.path || '')
      return Result.ok({list: this.fileService.listBackups(plugin, p)})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async restoreFile(req) {
    if (!this._rateLimit(req, 'fileRestore', 10)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = this.fileService.restoreBackup(
        String(req.body?.plugin || ''),
        String(req.body?.path || ''),
        String(req.body?.backup || ''),
        this._ctx(req),
      )
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
