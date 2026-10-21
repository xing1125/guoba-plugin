import {Service, autowired} from '#guoba.framework'

/**
 * 定时任务中心（后台调度）
 *
 * 任务 = 「什么时候 + 在哪个群/好友 + 发哪条指令」。
 * 执行时不直连插件，而是走 ConsoleService.exec 模拟一条真实消息，
 * 因此黑白名单、冷却、主人判断、插件自身的配置都照常生效，老插件零改造。
 *
 * cron 为 5 段标准写法（分 时 日 月 周），支持 * / a-b / a,b / *\/n 与 @daily 这类别名。
 * 调度用的是每 20 秒轮询 + 「同一分钟只跑一次」，不引入额外依赖；
 * 重启后靠 last_run_at 判断，不会因为重启把同一分钟的任务再跑一遍。
 */

const TICK_MS = 20_000
const NEXT_LIMIT_DAYS = 60
const HISTORY_KEY = 'Yz:Guoba:cron:history'
const HISTORY_MAX = 100

const FIELD_RULES = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 6], // 周（0 = 周日）
]

const ALIAS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 1',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

const pad = (n) => String(n).padStart(2, '0')

/** 本地时间到「分钟」的字符串，用来做同分钟去重（数据库存的是 UTC ISO，必须转回本地再比） */
function localMinute(d = new Date()) {
  const t = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(t.getTime())) return ''
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

function parseField(part, idx) {
  const [min, max] = FIELD_RULES[idx]
  if (!/^[\d*,\-/]+$/.test(part)) throw new Error(`第 ${idx + 1} 段只能是数字、* 、- 、/ 、,`)
  const set = new Set()
  for (const seg of part.split(',')) {
    if (!seg) throw new Error(`第 ${idx + 1} 段有空项`)
    const [range, stepRaw] = seg.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) throw new Error(`第 ${idx + 1} 段的步长不合法：${seg}`)
    let a
    let b
    if (range === '*') {
      a = min
      b = max
    } else if (range.includes('-')) {
      const [x, y] = range.split('-')
      a = Number(x)
      b = Number(y)
    } else {
      a = Number(range)
      b = Number(range)
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) {
      throw new Error(`第 ${idx + 1} 段超出范围（${min}-${max}）：${seg}`)
    }
    for (let v = a; v <= b; v += step) set.add(v)
  }
  if (!set.size) throw new Error(`第 ${idx + 1} 段没有有效值`)
  return set
}

/** 解析表达式，返回逐字段集合 + 是否通配 */
export function parseCron(expr) {
  const raw = String(expr ?? '').trim()
  if (!raw) throw new Error('cron 不能为空')
  const text = ALIAS[raw.toLowerCase()] || raw
  const parts = text.split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周，例如 0 8 * * *')
  return {
    text,
    source: raw,
    sets: parts.map((p, i) => parseField(p, i)),
    star: parts.map((p) => p === '*'),
  }
}

/** 判断某个时刻是否命中 */
export function matchCron(parsed, d = new Date()) {
  const [mi, ho, dom, mo, dow] = parsed.sets
  if (!mi.has(d.getMinutes()) || !ho.has(d.getHours()) || !mo.has(d.getMonth() + 1)) return false
  const domOk = dom.has(d.getDate())
  const dowOk = dow.has(d.getDay())
  // 日 / 周都不通配时按标准 cron 取并集，否则只认被限制的那个
  if (parsed.star[2] && parsed.star[4]) return true
  if (parsed.star[2]) return dowOk
  if (parsed.star[4]) return domOk
  return domOk || dowOk
}

/** 从 now 之后找下一次命中（分钟粒度） */
export function nextRun(parsed, from = new Date(), limitDays = NEXT_LIMIT_DAYS) {
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const max = limitDays * 24 * 60
  for (let i = 0; i < max; i++) {
    if (matchCron(parsed, d)) return new Date(d.getTime())
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

/** 人类可读的 cron 说明，前端直接用 */
export function describeCron(expr) {
  try {
    const p = parseCron(expr)
    const [mi, ho, dom, mo, dow] = p.sets
    const fmt = (set, unit) => {
      const arr = [...set].sort((a, b) => a - b)
      if (arr.length <= 4) return arr.join('、') + unit
      return `${arr.slice(0, 3).join('、')}…共 ${arr.length} 个${unit}`
    }
    const parts = []
    if (p.star[0] && p.star[1]) {
      parts.push('每分钟')
    } else if (p.star[0]) {
      parts.push(`每小时的第 ${fmt(mi, ' 分')}`)
    } else if (p.star[1]) {
      parts.push(`每小时 ${fmt(mi, ' 分')}`)
    } else {
      parts.push(`${fmt(ho, ' 点')} ${fmt(mi, ' 分')}`)
    }
    if (!p.star[2]) parts.push(`每月 ${fmt(dom, ' 号')}`)
    if (!p.star[3]) parts.push(`${fmt(mo, ' 月')}`)
    if (!p.star[4]) parts.push(`周${[...dow].sort((a, b) => a - b).map((d) => WEEK[d]).join('、')}`)
    return parts.join(' · ')
  } catch {
    return ''
  }
}

export class CronService extends Service {

  dbService = autowired('dbService')

  consoleService = autowired('consoleService')

  statsService = autowired('statsService')

  constructor(app) {
    super(app)
    this._timer = null
    this._ticking = false
    this._running = new Set()
    this._lastTick = null
    this._lastFired = new Map()
    this._nextCache = new Map()
  }

  get redis() {
    return globalThis.redis ?? null
  }

  /* ------------------------------ 调度循环 ------------------------------ */

  /** 由 GuobaApplication 启动时调用（幂等） */
  start() {
    if (this._timer) return
    this._timer = setInterval(() => {
      this.tick().catch(() => {})
    }, TICK_MS)
    // 不阻塞进程退出
    this._timer.unref?.()
    // 启动后先跑一次，避免刚好在整分钟重启而漏掉
    setTimeout(() => this.tick().catch(() => {}), 3000)?.unref?.()
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  async tick(now = new Date()) {
    if (this._ticking) return
    this._ticking = true
    this._lastTick = now.toISOString()
    try {
      const tasks = this.dbService.listCronTasks().filter((t) => t.enabled)
      if (!tasks.length) return
      const minuteKey = localMinute(now)
      for (const task of tasks) {
        let parsed
        try {
          parsed = parseCron(task.cron)
        } catch {
          continue // 表达式坏了就别再碰它，前端会标红提示
        }
        if (!matchCron(parsed, now)) continue
        // 同一分钟只跑一次：内存标记 + 数据库 last_run_at 双保险（重启也能兜住）
        if (this._lastFired.get(task.id) === minuteKey) continue
        if (task.last_run_at && localMinute(task.last_run_at) === minuteKey) continue
        this._lastFired.set(task.id, minuteKey)
        await this._run(task, 'cron')
      }
    } finally {
      this._ticking = false
    }
  }

  /** 真正执行一个任务 */
  async _run(task, source = 'manual') {
    if (this._running.has(task.id)) {
      return {ok: false, skipped: true, message: '上一次还在执行，本次跳过'}
    }
    this._running.add(task.id)
    const at = new Date().toISOString()
    try {
      const res = await this.consoleService.exec({
        kind: task.kind || 'group',
        id: task.target_id,
        cmd: task.cmd,
        deliver: !!task.deliver,
        asOwner: true,
        // 定时任务是主人预授权的，危险指令不再逐次确认
        confirm: true,
        skipThrottle: true,
        timeout: 20000,
      })
      const text = (res?.replies || []).join(' / ').slice(0, 400)
      this.dbService.touchCronTask(task.id, {status: 'ok', msg: text || '(执行完成，无回复)', at})
      await this._pushHistory({...task, at, ok: true, msg: text || '', source})
      return {ok: true, message: text}
    } catch (e) {
      const msg = String(e?.message || e)
      this.dbService.touchCronTask(task.id, {status: 'fail', msg, at})
      await this._pushHistory({...task, at, ok: false, msg, source})
      return {ok: false, message: msg}
    } finally {
      this._running.delete(task.id)
    }
  }

  async _pushHistory(entry) {
    try {
      if (!this.redis) return
      const payload = JSON.stringify({
        id: entry.id,
        name: entry.name,
        at: entry.at,
        ok: entry.ok,
        msg: String(entry.msg || '').slice(0, 200),
        cmd: entry.cmd,
        targetId: entry.target_id,
        targetName: entry.target_name,
        source: entry.source,
      })
      await this.redis.lPush(HISTORY_KEY, payload)
      await this.redis.lTrim(HISTORY_KEY, 0, HISTORY_MAX - 1)
    } catch {
      /* 历史只是辅助信息，写不进去不影响调度 */
    }
  }

  /* ------------------------------ 对外 ------------------------------ */

  _decorate(task) {
    let parsed = null
    let error = ''
    try {
      parsed = parseCron(task.cron)
    } catch (e) {
      error = e.message
    }
    let next = null
    if (parsed) {
      const key = `${task.cron}|${task.enabled}`
      const cached = this._nextCache.get(task.id)
      if (cached && cached.key === key && cached.at > Date.now()) {
        next = cached.next
      } else {
        next = nextRun(parsed)
        this._nextCache.set(task.id, {key, at: Date.now() + 30_000, next})
      }
    }
    return {
      ...task,
      deliver: !!task.deliver,
      enabled: !!task.enabled,
      cronError: error,
      cronDesc: error ? '' : describeCron(task.cron),
      nextRunAt: next ? next.toISOString() : null,
    }
  }

  list() {
    const tasks = this.dbService.listCronTasks().map((t) => this._decorate(t))
    return {
      tasks,
      running: this._running.size,
      lastTickAt: this._lastTick,
      enabledCount: tasks.filter((t) => t.enabled).length,
      failCount: tasks.filter((t) => t.last_status === 'fail').length,
    }
  }

  /** 可选的会话目标（群为主，Bot 运行时的群名最准） */
  targets() {
    const map = this.statsService.groupNameMap()
    const groups = [...map.entries()]
      .map(([gid, name]) => ({kind: 'group', id: String(gid), name: String(name || '')}))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return {groups, total: groups.length}
  }

  /** 校验并保存（id 为空 = 新建） */
  save(payload = {}, actor = '') {
    const name = String(payload.name || '').trim()
    const cron = String(payload.cron || '').trim()
    const cmd = String(payload.cmd || '').trim()
    const kind = payload.kind === 'private' ? 'private' : 'group'
    const targetId = String(payload.targetId || payload.target_id || '').trim()

    if (!name) throw new Error('任务名称不能为空')
    if (name.length > 40) throw new Error('任务名称最多 40 个字')
    if (!cmd) throw new Error('指令不能为空')
    if (cmd.length > 500) throw new Error('指令最多 500 个字')
    if (!targetId) throw new Error(kind === 'group' ? '请选择群' : '请填写 QQ 号')
    if (kind === 'group' && !/^\d+(@chatroom)?$/.test(targetId)) throw new Error('群号格式不对（应为纯数字或 xxx@chatroom）')
    if (kind === 'private' && !/^\d{5,12}$/.test(targetId)) throw new Error('QQ 号应为 5-12 位数字')

    const parsed = parseCron(cron) // 抛错即拒绝保存
    const next = nextRun(parsed)
    if (!next) throw new Error('这个表达式未来 60 天内不会触发，检查一下日期/月份')

    const data = {
      name,
      cron: parsed.text,
      kind,
      targetId,
      targetName: String(payload.targetName || payload.target_name || ''),
      cmd,
      deliver: payload.deliver !== false,
      enabled: payload.enabled !== false,
    }

    let task
    if (payload.id) {
      const old = this.dbService.getCronTask(payload.id)
      if (!old) throw new Error('任务不存在或已被删除')
      task = this.dbService.updateCronTask(old.id, data)
    } else {
      task = this.dbService.createCronTask({...data, createdBy: actor})
    }
    this._nextCache.delete(task.id)
    this.dbService.writeAudit({
      actor,
      action: payload.id ? 'cron.update' : 'cron.create',
      target: `cron:${task.id}`,
      detail: `${task.name} | ${task.cron} | ${task.kind}:${task.target_id} | ${task.cmd}`,
    })
    return this._decorate(task)
  }

  toggle(id, enabled, actor = '') {
    const task = this.dbService.getCronTask(id)
    if (!task) throw new Error('任务不存在')
    const next = this.dbService.updateCronTask(task.id, {enabled: !!enabled})
    this._nextCache.delete(task.id)
    this.dbService.writeAudit({
      actor,
      action: enabled ? 'cron.enable' : 'cron.disable',
      target: `cron:${task.id}`,
      detail: task.name,
    })
    return this._decorate(next)
  }

  remove(id, actor = '') {
    const task = this.dbService.getCronTask(id)
    if (!task) throw new Error('任务不存在')
    const ok = this.dbService.deleteCronTask(task.id)
    this._nextCache.delete(task.id)
    this._lastFired.delete(task.id)
    this.dbService.writeAudit({
      actor,
      action: 'cron.delete',
      target: `cron:${task.id}`,
      detail: `${task.name} | ${task.cmd}`,
    })
    return {deleted: ok}
  }

  async runNow(id, actor = '') {
    const task = this.dbService.getCronTask(id)
    if (!task) throw new Error('任务不存在')
    const res = await this._run(task, 'manual')
    this.dbService.writeAudit({
      actor,
      action: 'cron.run',
      target: `cron:${task.id}`,
      detail: `${task.name} → ${res.ok ? 'ok' : res.message}`,
    })
    return {...res, task: this._decorate(this.dbService.getCronTask(task.id))}
  }

  /** 表达式预览：未来 5 次触发时间 */
  preview(cron) {
    const parsed = parseCron(cron)
    const list = []
    let from = new Date()
    for (let i = 0; i < 5; i++) {
      const next = nextRun(parsed, from)
      if (!next) break
      list.push(next.toISOString())
      from = next
    }
    return {cron: parsed.text, desc: describeCron(parsed.text), next: list}
  }

  async history(limit = 30) {
    try {
      if (!this.redis) return []
      const rows = await this.redis.lRange(HISTORY_KEY, 0, Math.min(HISTORY_MAX, Math.max(1, Number(limit) || 30)) - 1)
      return (rows || [])
        .map((s) => {
          try {
            return JSON.parse(s)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }
}
