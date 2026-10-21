import {Service, autowired} from '#guoba.framework'

/**
 * 签到健康度 + 告警
 *
 * 思路：签到数据（Lotus checkin.jsonl）和账号状态（admin.db / data.db）都已经在
 * SignService 里聚合好了，这里只做三件事：
 *
 *   1. 打分 —— 把「CK 失效 / 连续失败 / 悬空绑定 / 今日成功率」折算成一个 0-100 的健康分
 *   2. 出告警 —— 固定几条规则，命中就生成告警（带稳定 key，便于去重）
 *   3. 推送 —— 新告警第一次出现时，给每个 Bot 的第一个主人发一条私聊（yenai 通知习惯）
 *
 * 告警状态存 Redis（Yz:Guoba:sign-alerts），消失即清除；再次出现会重新提醒一次。
 * 已知告警不重复轰炸，避免每天被同一句话骚扰。
 */

const STORE_KEY = 'Yz:Guoba:sign-alerts'

/** 周期体检间隔（毫秒）：30 分钟评估一次，只有新告警才推送 */
const TICK_MS = 30 * 60 * 1000

const LEVEL_ORDER = {ok: 0, warn: 1, bad: 2}

export class SignHealthService extends Service {

  signService = autowired('signService')

  constructor(app) {
    super(app)
    this._timer = null
    this._evaluating = false
  }

  get redis() {
    return globalThis.redis ?? null
  }

  /** 由 GuobaApplication 挂载完成后调用（幂等） */
  start() {
    if (this._timer) return
    this._timer = setInterval(() => {
      this.evaluate({notify: true}).catch(() => {})
    }, TICK_MS)
    this._timer.unref?.()
    // 启动 30 秒后先做一次，不阻塞插件加载
    setTimeout(() => this.evaluate({notify: true}).catch(() => {}), 30_000)?.unref?.()
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  /* ------------------------------ 健康快照 ------------------------------ */

  /**
   * 计算健康度。notify=false 时只算不推（页面查看用），
   * notify=true 时对新出现的告警发一条私聊给主人。
   */
  async evaluate({notify = false} = {}) {
    if (this._evaluating) return this.snapshot()
    this._evaluating = true
    try {
      const snapshot = this._compute()
      if (notify) {
        await this._notifyNew(snapshot.alerts)
      }
      return snapshot
    } finally {
      this._evaluating = false
    }
  }

  /** 只读：上次评估结果（不触发计算） */
  async snapshot() {
    const stored = await this._loadStore()
    return stored?.snapshot || null
  }

  _compute() {
    const alerts = []
    const checkedAt = new Date().toISOString()

    /* ---- 签到数据（今日 + 趋势） ---- */
    let today = null
    let todayRate = null
    let todayEmpty = false
    let dataAvailable = false
    try {
      const overview = this.signService.getOverview(7)
      dataAvailable = !!overview?.meta?.available
      if (overview?.today) {
        today = {
          date: overview.today.date,
          total: overview.today.total,
          ok: overview.today.ok,
          fail: overview.today.fail,
          users: overview.today.users,
          rate: overview.today.rate ?? 0,
        }
        todayRate = today.total > 0 ? today.rate : null
      }
      const nowHour = new Date().getHours()
      const todayDate = new Date()
      todayDate.setHours(0, 0, 0, 0)
      const lastDate = overview?.meta?.lastDate || ''
      const todayKey = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`
      todayEmpty = dataAvailable && lastDate < todayKey && nowHour >= 10
    } catch {
      /* 签到数据读不到就只看账号层面 */
    }

    /* ---- 账号体检 ---- */
    let expired = []
    let staleAllFail = []
    let orphanDangling = 0
    let orphanEmpty = 0
    try {
      const issues = this.signService.getIssues({days: 7})
      expired = issues?.expired || []
      staleAllFail = (issues?.stale || []).filter((s) => s.allFail)
      const orphan = issues?.orphan || []
      orphanDangling = orphan.filter((o) => o.kind === 'dangling').length
      orphanEmpty = orphan.filter((o) => o.kind === 'empty').length
    } catch {
      /* 同上 */
    }

    /* ---- 规则 ---- */
    if (expired.length) {
      alerts.push({
        key: 'sign-expired',
        level: expired.length >= 5 ? 'bad' : 'warn',
        title: `CK 失效 ${expired.length} 个账号`,
        detail: expired
          .slice(0, 5)
          .map((e) => e.bindNames?.filter(Boolean)?.[0] || `ltuid ${e.ltuid}`)
          .join('、') + (expired.length > 5 ? ` 等 ${expired.length} 个` : ''),
      })
    }
    if (staleAllFail.length) {
      alerts.push({
        key: 'sign-stale',
        level: 'bad',
        title: `${staleAllFail.length} 个账号近 7 天全部失败`,
        detail: staleAllFail
          .slice(0, 5)
          .map((s) => s.name || s.qq)
          .join('、') + (staleAllFail.length > 5 ? ` 等 ${staleAllFail.length} 个` : ''),
      })
    }
    if (orphanDangling > 0) {
      alerts.push({
        key: 'sign-orphan',
        level: 'warn',
        title: `${orphanDangling} 个用户的绑定全部失效`,
        detail: '账号已不存在或 CK 已过期，签到永远不会成功',
      })
    }
    if (today && today.total >= 5 && today.rate < 80) {
      alerts.push({
        key: 'sign-today-rate',
        level: 'warn',
        title: `今日签到成功率仅 ${Math.round(today.rate)}%`,
        detail: `${today.ok}/${today.total} 成功，${today.fail} 次失败，多半是 CK 或网络问题`,
      })
    }
    if (todayEmpty) {
      alerts.push({
        key: 'sign-today-empty',
        level: 'bad',
        title: '今天还没有任何签到记录',
        detail: '已过 10:00 仍无流水，签到计划可能没有跑起来',
      })
    }

    /* ---- 打分 ---- */
    let score = 100
    score -= Math.min(30, expired.length * 8)
    score -= Math.min(24, staleAllFail.length * 6)
    score -= Math.min(16, (orphanDangling + orphanEmpty) * 4)
    if (todayRate != null && today.total >= 5) {
      score -= Math.min(20, Math.round((95 - Math.min(95, todayRate)) * 0.6))
    }
    if (todayEmpty) score -= 10
    if (!dataAvailable) score = Math.min(score, 70)
    score = Math.max(0, Math.round(score))

    const worst = alerts.reduce((acc, a) => Math.max(acc, LEVEL_ORDER[a.level] || 0), 0)
    const level = alerts.length === 0 ? 'ok' : worst >= 2 ? 'bad' : 'warn'

    const snapshot = {
      checkedAt,
      score,
      level,
      dataAvailable,
      today,
      todayEmpty,
      counts: {
        expired: expired.length,
        staleAllFail: staleAllFail.length,
        orphanDangling,
        orphanEmpty,
      },
      alerts,
    }
    // 评估结果落 Redis，页面与重启后都能直接读
    this._saveStore(snapshot).catch(() => {})
    return snapshot
  }

  /* ------------------------------ 状态存取 ------------------------------ */

  async _loadStore() {
    try {
      if (!this.redis) return null
      const raw = await this.redis.get(STORE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  async _saveStore(snapshot) {
    try {
      if (!this.redis) return
      const known = {}
      try {
        const old = await this._loadStore()
        Object.assign(known, old?.known || {})
      } catch {}
      // 更新已知告警集合：仍在的保留，消失的移除
      const keys = new Set(snapshot.alerts.map((a) => a.key))
      for (const k of Object.keys(known)) {
        if (!keys.has(k)) delete known[k]
      }
      for (const a of snapshot.alerts) {
        if (!known[a.key]) {
          known[a.key] = {level: a.level, title: a.title, firstAt: snapshot.checkedAt}
        }
      }
      await this.redis.set(STORE_KEY, JSON.stringify({...snapshot, known, knownKeys: Object.keys(known)}))
    } catch {
      /* 状态丢了顶多多提醒一次 */
    }
  }

  async _knownKeys() {
    const stored = await this._loadStore()
    return new Set(stored?.knownKeys || [])
  }

  /* ------------------------------ 推送 ------------------------------ */

  /** 只把「这次新出现」的告警发给每个 Bot 的第一个主人 */
  async _notifyNew(alerts) {
    if (!alerts.length) return 0
    const known = await this._knownKeys()
    const fresh = alerts.filter((a) => !known.has(a.key))
    if (!fresh.length) return 0

    const lines = fresh.map((a) => `· [${a.level === 'bad' ? '严重' : '注意'}] ${a.title}${a.detail ? `（${a.detail}）` : ''}`)
    const text = `〖荧后台 · 签到告警〗\n${lines.join('\n')}\n→ 后台「签到中心 · 账号体检」可看明细`
    await this._sendToMasters(text)
    // 推送后把新 key 写进已知集合，避免 30 分钟后再推一遍
    try {
      const stored = (await this._loadStore()) || {}
      const knownNow = new Set(stored.knownKeys || [])
      for (const a of fresh) knownNow.add(a.key)
      await this.redis?.set(
        STORE_KEY,
        JSON.stringify({...stored, knownKeys: [...knownNow]}),
      )
    } catch {}
    return fresh.length
  }

  async _sendToMasters(text) {
    const bot = globalThis.Bot
    if (!bot?.uin) return 0
    let sent = 0
    try {
      const master = globalThis.cfg?.master ?? {}
      for (const uin of bot.uin ?? []) {
        const b = bot[uin]
        if (!b?.pickFriend) continue
        const list = master[String(uin)] ?? master[b.uin] ?? Object.values(master).flat()
        const qq = String((list || [])[0] ?? '')
        if (!qq) continue
        try {
          await b.pickFriend(qq).sendMsg(text)
          sent++
        } catch {
          /* 单个 bot 发不出去不影响其它 */
        }
      }
    } catch {}
    return sent
  }
}
