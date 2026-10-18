import fs from 'node:fs'
import multer from 'multer'
import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 喵喵面板图 / 角色图片管理接口（/api/admin/miao-img）
 *
 * 在后台替代聊天指令 `#上传xx面板图` / `#上传xx图片`：
 *   GET  /characters?kind=profile|character|art   有图的角色清单
 *   GET  /list?kind=&name=                    某角色图片列表
 *   POST /upload   (multipart: kind,name,files[])  上传（md5 命名，与喵喵约定一致）
 *   POST /delete   {kind,name,file,confirm}        删除（移入回收站）
 *   GET  /img?rel=                                 图片二进制预览（rel 限定在图片目录内）
 *
 * ⚠️ 框架 loadHelper 已在所有 POST 上全局注册 multer（upload.any()，磁盘存储），
 *    请求体到达这里时已被解析：直接用 req.files / req.body，勿再重复解析。
 */
export default class MiaoImgController extends ApiController {

  miaoImgService = autowired('miaoImgService')

  constructor(guobaApp) {
    super('/admin/miao-img', guobaApp)
    this._hits = new Map()
    // 兜底：极少数情况下全局 multer 未接管时自行解析（内存存储）
    this._upload = multer({
      storage: multer.memoryStorage(),
      limits: {fileSize: 10 * 1024 * 1024, files: 10},
    }).any()
  }

  registerRouters() {
    this.get('/characters', this.characters)
    this.get('/list', this.list)
    this.post('/upload', this.upload)
    this.post('/delete', this.remove)
    this.get('/img', this.img)
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

  /** 用 Promise 包一层 multer 中间件 */
  _runUpload(req, res) {
    return new Promise((resolve, reject) => {
      this._upload(req, res, (err) => (err ? reject(err) : resolve()))
    })
  }

  async characters(req) {
    try {
      return Result.ok(this.miaoImgService.characters(String(req.query?.kind || '')))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async list(req) {
    try {
      return Result.ok(this.miaoImgService.list(
        String(req.query?.kind || ''),
        String(req.query?.name || ''),
      ))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async upload(req, res) {
    if (!this._rateLimit(req, 'miaoUpload', 30)) {
      return Result.error('上传过于频繁，请稍后再试')
    }
    try {
      let files = Array.isArray(req.files) ? req.files : null
      if (!files) {
        // 全局 multer 未接管时兜底自行解析
        await this._runUpload(req, res)
        files = req.files || []
      }
      files = files.filter((f) => f.fieldname === 'files')
      if (!files.length) {
        return Result.error('未收到图片文件（字段名 files）')
      }
      const kind = String(req.body?.kind || '')
      const name = String(req.body?.name || '')
      const saved = []
      const failed = []
      for (const f of files) {
        try {
          // 磁盘存储（全局 multer）：从 f.path 读；内存存储（兜底）：直接 f.buffer
          const buffer = Buffer.isBuffer(f.buffer) ? f.buffer : fs.readFileSync(f.path)
          try {
            if (f.path && !Buffer.isBuffer(f.buffer)) fs.unlinkSync(f.path)
          } catch {}
          saved.push(await this.miaoImgService.save(kind, name, buffer, f.originalname, this._ctx(req)))
        } catch (e) {
          failed.push({file: f.originalname, reason: e.message})
        }
      }
      return Result.ok({saved, failed, count: saved.length})
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async remove(req) {
    if (!this._confirmed(req)) {
      return Result.error('缺少二次确认参数 confirm=true')
    }
    if (!this._rateLimit(req, 'miaoRemove', 20)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      const data = await this.miaoImgService.remove(
        String(req.body?.kind || ''),
        String(req.body?.name || ''),
        String(req.body?.file || ''),
        this._ctx(req),
      )
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  /** 图片二进制直发（鉴权同其它接口：header 或 ?token=） */
  async img(req, res) {
    try {
      const {mime, buffer} = this.miaoImgService.readImage(String(req.query?.rel || ''))
      res.type(mime)
      res.set('Cache-Control', 'private, max-age=3600')
      res.send(buffer)
      return Result.VOID
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
