import {autowired, Result} from '#guoba.framework'
import {ApiController} from '#guoba.platform'

/**
 * 游戏签到数据接口
 *
 * 数据源：
 *  - Lotus-Plugin 的签到审计流水（data/audit/checkin.jsonl）→ /admin/sign/*
 *  - Cloudtide Waves-plugin 的签到计划归档（data/schedules/*.json）→ /admin/sign/waves/*
 * 全部只读，不触碰 Bot 主库。
 */
export default class SignController extends ApiController {

  signService = autowired('signService')

  wavesSignService = autowired('wavesSignService')

  constructor(guobaApp) {
    super('/admin/sign', guobaApp)
  }

  registerRouters() {
    this.get('/overview', this.overview)
    this.get('/records', this.records)
    this.get('/day/:date', this.day)
    this.get('/waves/overview', this.wavesOverview)
    this.get('/waves/records', this.wavesRecords)
    this.get('/waves/day/:date', this.wavesDay)
  }

  async overview(req) {
    const days = Number(req.query?.days) || 14
    const data = this.signService.getOverview(days)
    if (!data.available) {
      return Result.error('没有找到签到流水文件（Lotus-Plugin/data/audit/checkin.jsonl）')
    }
    return Result.ok(data)
  }

  async records(req) {
    const {date, q, ok, game, status, page, size} = req.query || {}
    const data = this.signService.queryRecords({
      date: date ? String(date) : '',
      q: q ? String(q) : '',
      ok: ok ? String(ok) : '',
      game: game ? String(game) : '',
      status: status ? String(status) : '',
      page: Number(page) || 1,
      size: Number(size) || 20,
    })
    return Result.ok(data)
  }

  async day(req) {
    const date = req.params?.date ? String(req.params.date) : ''
    const data = this.signService.getDay(date)
    return Result.ok(data.available ? data : {...data, userList: []})
  }

  /* ------------------------------ 鸣潮签到 ------------------------------ */

  async wavesOverview(req) {
    const days = Number(req.query?.days) || 14
    const data = this.wavesSignService.getOverview(days)
    if (!data.available) {
      return Result.error('没有找到鸣潮签到归档（Cloudtide Waves-plugin/data/schedules/*.json）')
    }
    return Result.ok(data)
  }

  async wavesRecords(req) {
    const {date, q, ok, page, size} = req.query || {}
    const data = this.wavesSignService.queryRecords({
      date: date ? String(date) : '',
      q: q ? String(q) : '',
      ok: ok ? String(ok) : '',
      page: Number(page) || 1,
      size: Number(size) || 20,
    })
    return Result.ok(data)
  }

  async wavesDay(req) {
    const date = req.params?.date ? String(req.params.date) : ''
    const data = this.wavesSignService.getDay(date)
    return Result.ok(data.available ? data : {...data, userList: []})
  }
}
