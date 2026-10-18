import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * YingAI 私聊管理接口（/api/admin/yingai）
 *
 * 只读为主：概览 / 用户表 / 用户对比 / 聊天记录 / 智能诊断
 * 唯一写操作：单用户开关（写 userFlags.json，遵循"与全局一致即删除覆盖"语义）
 */
export default class YingAIController extends ApiController {

  yingAiService = autowired('yingAiService')

  constructor(guobaApp) {
    super('/admin/yingai', guobaApp)
  }

  registerRouters() {
    this.get('/overview', this.overview)
    this.get('/users', this.users)
    this.get('/compare', this.compare)
    this.get('/messages', this.messages)
    this.get('/insights', this.insights)
    this.post('/user/enabled', this.setEnabled)
  }

  async overview() {
    return Result.ok(this.yingAiService.overview())
  }

  async users(req) {
    const {page, size, q, enabled} = req.query
    return Result.ok(this.yingAiService.users({
      page: Number(page) || 1,
      size: Number(size) || 20,
      q: q ? String(q).trim() : '',
      enabled: enabled != null ? String(enabled) : '',
    }))
  }

  async compare() {
    return Result.ok(this.yingAiService.compare())
  }

  async messages(req) {
    const uid = String(req.query.uid || '')
    if (!uid) return Result.error('缺少 uid')
    return Result.ok(this.yingAiService.messages(uid, {
      page: Number(req.query.page) || 1,
      size: Number(req.query.size) || 50,
    }))
  }

  /** uid 为空 = 综合（全体）视角；带 uid = 单用户视角（与全体均值对照） */
  async insights(req) {
    return Result.ok(this.yingAiService.insights(String(req.query?.uid || '')))
  }

  async setEnabled(req) {
    const uid = String(req.body?.uid || '')
    const enabled = req.body?.enabled
    if (!uid) return Result.error('缺少 uid')
    if (typeof enabled !== 'boolean') return Result.error('enabled 必须是布尔值')
    try {
      const data = this.yingAiService.setEnabled(uid, enabled)
      return Result.ok(data)
    } catch (e) {
      return Result.error(`保存失败：${e?.message || e}`)
    }
  }
}
