import {Service, autowired} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 每日快照采集
 *
 * 后台现有的数据都只有「当前值」：
 *   · YingAI/data/emotion/<gid>.json 只有一份 {mood, value, updatedAt}
 *   · miao:rank:* 是 Redis zset 的实时分数
 * 所以「情绪曲线」「战力榜历史趋势」这类时序图做不出来。
 *
 * 这里的做法很朴素：每小时醒一次，把当下的情绪 + 战力各拍一张照，
 * 落到 data/snapshots/<YYYY-MM-DD>.json —— 同一天就是覆盖，天然只留当天最后一次。
 * 只保留最近 KEEP_DAYS 天，超期的从旧开始删。
 *
 * 采集失败绝不能影响后台：所有异常在这里被吃掉，只留一条 warn。
 */

/** 快照保留天数 */
const KEEP_DAYS = 90
/** 检查间隔（毫秒）：每小时一次，同一天反复覆盖 */
const TICK_MS = 60 * 60 * 1000
/** 合法快照文件名 */
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/

export class SnapshotService extends Service {

  yingMindService = autowired('yingMindService')
  rankService = autowired('rankService')

  constructor(app) {
    super(app)
    this.dir = path.join(_paths.root, 'data', 'snapshots')
    this._timer = null
  }

  /** 由 GuobaApplication 挂载完成后调用（幂等） */
  start() {
    if (this._timer) return
    this._timer = setInterval(() => this._safeTake(), TICK_MS)
    this._timer.unref?.()
    // 启动 8 秒后先采一次：等 Redis / miao 插件的数据就绪
    setTimeout(() => this._safeTake(), 8000)?.unref?.()
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  /** 定时器专用入口：任何异常都不许往外抛 */
  async _safeTake() {
    try {
      return await this.take()
    } catch (e) {
      logger?.warn?.(`[Snapshot] 采集失败：${e.message}`)
    }
  }

  /* ------------------------------ 采集 ------------------------------ */

  /**
   * 立刻采集一次并落盘，返回快照对象
   * @param {boolean} force 手动采集语义（当前不做跳过判断，只用于接口区分）
   */
  async take(force = false) {
    fs.mkdirSync(this.dir, {recursive: true})
    const date = this._today()
    const emotion = this._collectEmotion()
    const rank = await this._collectRank()
    const snapshot = {date, takenAt: Date.now(), emotion, rank}

    // 原子写：先 tmp 再 rename，避免读到半截文件
    const file = path.join(this.dir, `${date}.json`)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    fs.renameSync(tmp, file)

    this._prune()
    logger?.mark?.(`[Snapshot] 已采集 ${date}：情绪 ${emotion.length} 条 / 战力 ${rank.length} 群`)
    return snapshot
  }

  /** 情绪：直接借 YingMindService.groups() 的结果 */
  _collectEmotion() {
    try {
      const list = this.yingMindService?.groups?.() || []
      return list
        .filter((g) => g?.gid)
        .map((g) => ({
          gid: String(g.gid),
          name: g.name || '',
          mood: g.mood || '',
          value: Number(g.moodValue) || 0,
        }))
    } catch (e) {
      logger?.warn?.(`[Snapshot] 情绪采集失败：${e.message}`)
      return []
    }
  }

  /** 战力：miao 的 zset 不可用时给空数组，不让整张快照失败 */
  async _collectRank() {
    try {
      const overview = await this.rankService?.overview?.()
      if (!overview || overview.available === false) return []
      return (overview.groups || [])
        .filter((g) => g?.gid)
        .map((g) => ({
          gid: String(g.gid),
          name: g.name || '',
          members: Number(g.members) || 0,
          charCount: Number(g.charCount) || 0,
          topCharName: g.topChar?.name || '',
          topCharCount: Number(g.topChar?.count) || 0,
        }))
    } catch (e) {
      logger?.warn?.(`[Snapshot] 战力采集失败：${e.message}`)
      return []
    }
  }

  /* ------------------------------ 查询 ------------------------------ */

  /**
   * 快照目录概览
   * @returns {{dir: string, files: string[], count: number, latest: object|null}}
   */
  list(days = 30) {
    const n = this._clampDays(days)
    const files = []
    for (const date of this._dates().reverse()) {
      if (files.length >= n) break
      if (!this._read(date)) continue
      files.push(date)
    }
    return {
      dir: this.dir,
      files,
      count: files.length,
      latest: files.length ? this._summary(files[0]) : null,
    }
  }

  /**
   * 情绪曲线：gid 为空取全站平均（每天一个点）
   * @returns {{gid: string, days: number, points: Array, count: number}}
   */
  emotionTrend({gid = '', days = 30} = {}) {
    const key = this._normGid(gid)
    const points = []
    for (const {date, data} of this._recent(days)) {
      const rows = (data.emotion || []).filter((r) => r && (key ? String(r.gid) === key : true))
      if (!rows.length) continue
      if (key) {
        const r = rows[0]
        points.push({date, mood: r.mood || '', value: this._round1(r.value)})
        continue
      }
      // 全站：情绪取当天出现最多的那个（并列取第一个），数值取所有群平均
      const counter = new Map()
      for (const r of rows) {
        const mood = r.mood || ''
        counter.set(mood, (counter.get(mood) || 0) + 1)
      }
      let mood = ''
      let best = -1
      for (const [m, c] of counter) {
        if (c > best) {
          best = c
          mood = m
        }
      }
      const sum = rows.reduce((s, r) => s + (Number(r.value) || 0), 0)
      points.push({date, mood, value: this._round1(sum / rows.length)})
    }
    return {gid: key, days: this._clampDays(days), points, count: points.length}
  }

  /**
   * 战力趋势：gid 为空取全站汇总（members / charCount 求和，topChar 取当天人数最高的）
   * @returns {{gid: string, days: number, points: Array, count: number}}
   */
  rankTrend({gid = '', days = 30} = {}) {
    const key = this._normGid(gid)
    const points = []
    for (const {date, data} of this._recent(days)) {
      const rows = (data.rank || []).filter((r) => r && (key ? String(r.gid) === key : true))
      if (!rows.length) continue
      if (key) {
        const r = rows[0]
        points.push({
          date,
          members: Number(r.members) || 0,
          charCount: Number(r.charCount) || 0,
          topCharName: r.topCharName || '',
          topCharCount: Number(r.topCharCount) || 0,
        })
        continue
      }
      let members = 0
      let charCount = 0
      let top = null
      for (const r of rows) {
        members += Number(r.members) || 0
        charCount += Number(r.charCount) || 0
        if (!top || (Number(r.topCharCount) || 0) > (Number(top.topCharCount) || 0)) top = r
      }
      points.push({
        date,
        members,
        charCount,
        topCharName: top?.topCharName || '',
        topCharCount: Number(top?.topCharCount) || 0,
      })
    }
    return {gid: key, days: this._clampDays(days), points, count: points.length}
  }

  /* ------------------------------ 磁盘 ------------------------------ */

  /** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC，凌晨会差一天） */
  _today() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** 目录里所有快照日期，正序 */
  _dates() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => FILE_RE.test(f))
        .map((f) => f.slice(0, 10))
        .sort()
    } catch {
      return []
    }
  }

  _read(date) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${date}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  /** 最近 N 天且能解析的快照，正序（旧 → 新） */
  _recent(days) {
    const n = this._clampDays(days)
    const out = []
    for (const date of this._dates().slice(-n)) {
      const data = this._read(date)
      if (data) out.push({date, data})
    }
    return out
  }

  _summary(date) {
    const data = this._read(date) || {}
    return {
      date,
      takenAt: Number(data.takenAt) || 0,
      emotionCount: (data.emotion || []).length,
      rankCount: (data.rank || []).length,
    }
  }

  /** 超过 KEEP_DAYS 的从旧开始删 */
  _prune() {
    const dates = this._dates()
    const drop = dates.length - KEEP_DAYS
    if (drop <= 0) return
    for (const date of dates.slice(0, drop)) {
      try {
        fs.rmSync(path.join(this.dir, `${date}.json`), {force: true})
      } catch { /* 删不掉下次再删 */ }
    }
  }

  _clampDays(days) {
    const n = Number(days)
    if (!Number.isFinite(n) || n <= 0) return 30
    return Math.min(Math.floor(n), 365)
  }

  _normGid(gid) {
    return String(gid ?? '').trim().replace(/@chatroom$/, '')
  }

  _round1(v) {
    const n = Number(v) || 0
    return Math.round(n * 10) / 10
  }
}
