import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 定时任务中心接口
 *
 *   GET  /admin/cron/tasks      任务列表（含下次触发时间）
 *   GET  /admin/cron/targets    可选群列表
 *   GET  /admin/cron/history    最近执行记录
 *   GET  /admin/cron/preview    表达式预览（未来 5 次）
 *   POST /admin/cron/save       新建 / 修改（需 confirm）
 *   POST /admin/cron/toggle     启用 / 停用
 *   POST /admin/cron/delete     删除（需 confirm）
 *   POST /admin/cron/run        立即执行一次
 *
 * 执行走 ConsoleService 模拟消息，不直连插件。
 */
export default class CronController extends ApiController {

  cronService = autowired('cronService')

  constructor(guobaApp) {
    super('/admin/cron', guobaApp)
    this._hits = new Map()
  }

  registerRouters() {
    this.get('/tasks', this.tasks)
    this.get('/targets', this.targets)
    this.get('/history', this.history)
    this.get('/preview', this.preview)
    this.post('/save', this.save)
    this.post('/toggle', this.toggle)
    this.post('/delete', this.remove)
    this.post('/run', this.run)
  }

  _actor(req) {
    return String(req.user?.username || 'admin')
  }

  _rateLimit(req, action, times = 20, windowMs = 60_000) {
    const key = `${action}:${req.ip || req.socket?.remoteAddress || 'unknown'}`
    const now = Date.now()
    const list = (this._hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= times) return false
    list.push(now)
    this._hits.set(key, list)
    if (this._hits.size > 500) {
      for (const [k, v] of this._hits) {
        if (!v.some((t) => now - t < windowMs)) this._hits.delete(k)
      }
    }
    return true
  }

  async tasks() {
    return Result.ok(this.cronService.list())
  }

  async targets() {
    return Result.ok(this.cronService.targets())
  }

  async history(req) {
    return Result.ok(await this.cronService.history(Number(req.query?.limit) || 30))
  }

  async preview(req) {
    const cron = String(req.query?.cron || '').trim()
    if (!cron) return Result.error('缺少 cron 表达式')
    try {
      return Result.ok(this.cronService.preview(cron))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async save(req) {
    if (req.body?.confirm !== true) return Result.error('缺少确认标记（confirm）')
    if (!this._rateLimit(req, 'cron.save', 30)) return Result.error('操作过于频繁，请稍后再试')
    try {
      return Result.ok(this.cronService.save(req.body || {}, this._actor(req)))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async toggle(req) {
    const id = Number(req.body?.id)
    if (!id) return Result.error('缺少任务 ID')
    if (!this._rateLimit(req, 'cron.toggle', 60)) return Result.error('操作过于频繁，请稍后再试')
    try {
      return Result.ok(this.cronService.toggle(id, !!req.body?.enabled, this._actor(req)))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async remove(req) {
    const id = Number(req.body?.id)
    if (!id) return Result.error('缺少任务 ID')
    if (req.body?.confirm !== true) return Result.error('删除需要二次确认（confirm）')
    if (!this._rateLimit(req, 'cron.delete', 20)) return Result.error('操作过于频繁，请稍后再试')
    try {
      return Result.ok(this.cronService.remove(id, this._actor(req)))
    } catch (e) {
      return Result.error(e.message)
    }
  }

  async run(req) {
    const id = Number(req.body?.id)
    if (!id) return Result.error('缺少任务 ID')
    if (!this._rateLimit(req, 'cron.run', 10)) return Result.error('执行太频繁，请等一会儿再试')
    try {
      const res = await this.cronService.runNow(id, this._actor(req))
      return Result.ok(res)
    } catch (e) {
      return Result.error(e.message)
    }
  }
}
