import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 运行日志中心接口（/api/admin/logs）
 *
 * 把 `app/logs` 下的运行流水与错误堆栈接到后台，省掉手动翻文件夹：
 *   GET  /files                      日志文件清单
 *   GET  /entries?file&lines&level&q 按级别 / 关键字取尾部条目
 *   GET  /summary                    今日错误数、最近一条错误、占用
 *   GET  /download?file              下载原始文件
 *   POST /clear  {file, confirm:true} 清空（写审计）
 *
 * 只读为主；清空需要 confirm 且限流，gz 归档拒绝清空。
 */
export default class LogController extends ApiController {

  logService = autowired('logService')

  constructor(guobaApp) {
    super('/admin/logs', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/files', this.files)
    this.get('/entries', this.entries)
    this.get('/summary', this.summary)
    this.get('/download', this.download)
    this.post('/clear', this.clear)
  }

  _ctx(req) {
    return {
      actor: String(req.user?.username || req.body?.actor || ''),
      ip: String(req.ip || req.socket?.remoteAddress || ''),
    }
  }

  _rateLimit(req, action, times = 10, windowMs = 60_000) {
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
        if (!v.some((t) => now - t < windowMs)) {
          this._hits.delete(k)
        }
      }
    }
    return true
  }

  async files() {
    try {
      return Result.ok(this.logService.listFiles())
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async entries(req) {
    try {
      const data = this.logService.read({
        file: String(req.query?.file || ''),
        lines: Number(req.query?.lines) || 300,
        level: req.query?.level ? String(req.query.level) : '',
        q: req.query?.q ? String(req.query.q) : '',
      })
      return Result.ok(data)
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async summary() {
    try {
      return Result.ok(this.logService.summary())
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async download(req, res) {
    try {
      const {name, buffer, size, gz} = this.logService.download(String(req.query?.file || ''))
      res.setHeader('Content-Type', gz ? 'application/gzip' : 'text/plain; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`)
      res.setHeader('Content-Length', String(size))
      res.send(buffer)
      return Result.VOID
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async clear(req) {
    const confirm = req.body?.confirm
    if (confirm !== true && confirm !== 'CLEAR' && confirm !== 'clear') {
      return Result.error('清空日志需要 confirm:true 确认')
    }
    if (!this._rateLimit(req, 'logClear', 6)) {
      return Result.error('操作过于频繁，请稍后再试')
    }
    try {
      return Result.ok(this.logService.clear(String(req.body?.file || ''), this._ctx(req)))
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
