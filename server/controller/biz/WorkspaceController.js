import fs from 'node:fs'
import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 工作区文件管理接口（/api/admin/workspace）
 *
 * 在后台直接浏览 / 编辑云崽的配置与插件文件：
 *   GET  /roots                      工作区根清单（config / plugins）
 *   GET  /list?root&path             列目录
 *   GET  /read?root&path             读文件
 *   POST /write   {root,path,content}          保存（自动备份 + json/yaml 校验）
 *   POST /create  {root,path,name,isDir,content} 新建文件/目录
 *   POST /delete  {root,path,confirm}          删除（移入回收站，需 confirm:true）
 *   POST /rename  {root,path,newName}          重命名
 *   GET  /backups?root&path             备份列表
 *   POST /backup/restore {root,path,backup} 从备份恢复
 *   GET  /download?root&path            下载文件（≤20MB，附件直发）
 *   GET  /trash                         回收站条目列表
 *   POST /trash/remove {name,confirm}    彻底删除单个回收站条目
 *   POST /trash/clear {confirm}          清空回收站
 *
 * 写操作必须走 data:write 权限（RBAC），且带限流与审计。
 */
export default class WorkspaceController extends ApiController {

  workspaceService = autowired('workspaceService')

  constructor(guobaApp) {
    super('/admin/workspace', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/roots', this.roots)
    this.get('/list', this.list)
    this.get('/read', this.read)
    this.post('/write', this.write)
    this.post('/create', this.create)
    this.post('/delete', this.remove)
    this.post('/rename', this.rename)
    this.get('/backups', this.backups)
    this.post('/backup/restore', this.restoreBackup)
    this.get('/download', this.download)
    this.get('/trash', this.trash)
    this.post('/trash/remove', this.trashRemove)
    this.post('/trash/clear', this.trashClear)
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

  async roots() {
    try {
      return Result.ok({list: this.workspaceService.roots()})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async list(req) {
    try {
      return Result.ok(this.workspaceService.list(
        String(req.query?.root || ''),
        req.query?.path ? String(req.query.path) : '',
      ))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async read(req) {
    try {
      return Result.ok(await this.workspaceService.read(
        String(req.query?.root || ''),
        String(req.query?.path || ''),
      ))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async write(req) {
    if (!this._rateLimit(req, 'wsWrite', 40)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = await this.workspaceService.write(
        String(req.body?.root || ''),
        String(req.body?.path || ''),
        req.body?.content,
        this._ctx(req),
      )
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async create(req) {
    if (!this._rateLimit(req, 'wsCreate', 20)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = await this.workspaceService.create(
        String(req.body?.root || ''),
        req.body?.path ? String(req.body.path) : '',
        String(req.body?.name || ''),
        req.body?.isDir === true,
        req.body?.content || '',
        this._ctx(req),
      )
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async remove(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'wsRemove', 10)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    try {
      const data = await this.workspaceService.remove(
        String(req.body?.root || ''),
        String(req.body?.path || ''),
        this._ctx(req),
      )
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async rename(req) {
    if (!this._rateLimit(req, 'wsRename', 20)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = await this.workspaceService.rename(
        String(req.body?.root || ''),
        String(req.body?.path || ''),
        String(req.body?.newName || ''),
        this._ctx(req),
      )
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async backups(req) {
    try {
      return Result.ok({list: this.workspaceService.backups(
        String(req.query?.root || ''),
        String(req.query?.path || ''),
      )})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async restoreBackup(req) {
    if (!this._rateLimit(req, 'wsRestore', 10)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    try {
      const data = await this.workspaceService.restoreBackup(
        String(req.body?.root || ''),
        String(req.body?.path || ''),
        String(req.body?.backup || ''),
        this._ctx(req),
      )
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 下载文件：二进制附件直发（token 可走 ?token= 供浏览器直接打开） */
  async download(req, res) {
    try {
      const {target, name, ext, size} = this.workspaceService.download(
        String(req.query?.root || ''),
        String(req.query?.path || ''),
      )
      const mimeMap = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
      }
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream')
      res.setHeader('Content-Length', String(size))
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="download${ext || '.bin'}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      res.send(fs.readFileSync(target))
      return Result.VOID
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async trash(req) {
    try {
      return Result.ok({list: this.workspaceService.trashList()})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async trashRemove(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'wsTrashRemove', 20)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    try {
      return Result.ok(this.workspaceService.trashRemove(String(req.body?.name || ''), this._ctx(req)))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async trashClear(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'wsTrashClear', 5)) {
      return Result.error('操作过于频繁，请 1 分钟后再试')
    }
    try {
      return Result.ok(this.workspaceService.trashClear(this._ctx(req)))
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
