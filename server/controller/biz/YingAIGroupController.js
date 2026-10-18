import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * YingAI 群聊聊天记录接口（/api/admin/yingai-group）
 *
 * 只读。数据源：<plugins>/YingAI/data/diag/*.jsonl
 * 与「荧 · 聊天记录诊断大屏」前端一一对应：
 *   GET /meta      筛选元信息（可用日期 + 群列表 + 真名）
 *   GET /dashboard 大屏主数据（KPI / 机器腔 / 长度 / 模型 / 缺陷 / 结论 / 异常）
 *   GET /turns     原始对话分页表（支持搜索、只看异常、按群过滤）
 */
export default class YingAIGroupController extends ApiController {

  yingAiGroupService = autowired('yingAiGroupService')

  constructor(guobaApp) {
    super('/admin/yingai-group', guobaApp)
  }

  registerRouters() {
    this.get('/meta', this.meta)
    this.get('/dashboard', this.dashboard)
    this.get('/turns', this.turns)
  }

  /** 统一解析筛选参数：days=0 表示全部 */
  _range(req) {
    const q = req.query || {}
    const days = q.days != null && q.days !== '' ? Math.max(0, Number(q.days) || 0) : 7
    return {
      days,
      from: q.from ? String(q.from) : '',
      to: q.to ? String(q.to) : '',
      gid: q.gid ? String(q.gid) : '',
    }
  }

  async meta() {
    try {
      return Result.ok(await this.yingAiGroupService.meta())
    } catch (e) {
      return Result.error(`读取 diag 元信息失败：${e?.message || e}`)
    }
  }

  async dashboard(req) {
    try {
      return Result.ok(await this.yingAiGroupService.dashboard(this._range(req)))
    } catch (e) {
      return Result.error(`统计失败：${e?.message || e}`)
    }
  }

  async turns(req) {
    const q = req.query || {}
    try {
      return Result.ok(await this.yingAiGroupService.turns({
        ...this._range(req),
        q: q.q ? String(q.q) : '',
        onlyAbnormal: q.onlyAbnormal === '1' || q.onlyAbnormal === 'true',
        page: Number(q.page) || 1,
        size: Number(q.size) || 50,
      }))
    } catch (e) {
      return Result.error(`读取对话记录失败：${e?.message || e}`)
    }
  }
}
