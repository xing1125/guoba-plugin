import fs from 'node:fs'
import path from 'node:path'
import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 游戏签到数据服务
 *
 * 数据源：Lotus-Plugin（荷花签到）的审计流水
 *   `<Yunzai>/app/plugins/Lotus-Plugin/data/audit/checkin.jsonl`
 * 每行一条 JSON：{ time, qq, profileId, ok, stage, source, message }
 *
 * message 里按「游戏名:」分段，正文形如：
 *   原神:
 *   雨落梦秋已连续签到18天
 *   今天获得的奖励是「原石」x20
 *   崩坏：星穹铁道:
 *   并没有绑定任何崩坏：星穹铁道账号
 *   米游社:
 *   今天已经获得 50 个米游币
 *   还能获得 0 个米游币
 *   目前有 2620 个米游币
 *
 * 本服务只读文件，不写入任何数据；解析结果按 (mtime,size) 缓存。
 */

/** 游戏定义（顺序即展示顺序） */
const GAMES = [
  {key: 'mys', label: '米游社', color: '#4FA8D8'},
  {key: 'gs', label: '原神', color: '#D3BC8D'},
  {key: 'sr', label: '崩坏：星穹铁道', color: '#8D83E8'},
  {key: 'zzz', label: '绝区零', color: '#45B97C'},
  {key: 'bh3', label: '崩坏3', color: '#FF8A65'},
  {key: 'bh2', label: '崩坏学园2', color: '#62A8EA'},
  {key: 'wd', label: '未定事件簿', color: '#CE7C9B'},
]

/** 段落标题（去掉冒号）→ 游戏 key */
function gameKeyOf(title) {
  const t = String(title || '').replace(/[:：]\s*$/, '').trim()
  if (!t) {
    return null
  }
  if (t === '米游社') {
    return 'mys'
  }
  if (t === '原神') {
    return 'gs'
  }
  if (t.includes('星穹铁道')) {
    return 'sr'
  }
  if (t.includes('绝区零')) {
    return 'zzz'
  }
  if (t.includes('崩坏3') || t.includes('崩坏三')) {
    return 'bh3'
  }
  if (t.includes('崩坏学园2') || t.includes('崩坏学园二')) {
    return 'bh2'
  }
  if (t.includes('未定事件簿')) {
    return 'wd'
  }
  return null
}

/**
 * 解析一条 message 的各游戏状态
 * @returns {{key:string,status:'signed'|'unbound'|'failed'|'unknown',days:number|null,reward:string|null,text:string}[]}
 */
export function parseGames(message) {
  const raw = String(message || '')
  if (!raw.trim()) {
    return []
  }
  const blocks = raw.split(/\n{2,}/)
  const out = []
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) {
      continue
    }
    // 首行可能是「原神:」也可能是「原神: 雨落梦秋已连续签到18天」
    const headMatch = lines[0].match(/^([^::]{1,20})[:：]\s*(.*)$/)
    if (!headMatch) {
      continue
    }
    const key = gameKeyOf(headMatch[1])
    if (!key) {
      continue
    }
    const body = [headMatch[2], ...lines.slice(1)].filter(Boolean).join('\n')
    const text = body.replace(/\s+/g, ' ').trim()

    let status = 'unknown'
    let days = null
    let reward = null

    if (/并没有绑定|未绑定任何/.test(text)) {
      status = 'unbound'
    } else if (/已连续签到\s*(\d+)\s*天/.test(text)) {
      status = 'signed'
      days = Number(text.match(/已连续签到\s*(\d+)\s*天/)?.[1] || 0) || null
    } else if (/今天已经获得\s*(\d+)\s*个米游币/.test(text)) {
      status = 'signed'
    } else if (/签到失败|请先.*登录|ck.*失效|cookie.*失效|登录失效/i.test(text)) {
      status = 'failed'
    } else if (/今天获得的奖励是/.test(text)) {
      status = 'signed'
    }

    const rw = text.match(/今天获得的奖励是「(.+?)」\s*[x×]\s*(\d+)/)
    if (rw) {
      reward = `${rw[1]}×${rw[2]}`
    }
    out.push({key, status, days, reward, text: text.slice(0, 160)})
  }
  return out
}

/** 从 message 里取米游币信息 */
function parseCoins(message) {
  const raw = String(message || '')
  const cur = raw.match(/目前有\s*(\d+)\s*个米游币/)
  const today = raw.match(/今天已经获得\s*(\d+)\s*个米游币/)
  const rest = raw.match(/还能获得\s*(\d+)\s*个米游币/)
  if (!cur && !today) {
    return null
  }
  return {
    current: cur ? Number(cur[1]) : null,
    todayGain: today ? Number(today[1]) : null,
    rest: rest ? Number(rest[1]) : null,
  }
}

function dateOf(iso) {
  return String(iso || '').slice(0, 10)
}

/** 宽松解析 MysUsers.uids（不限定游戏 key，脏数据返回空对象而不是抛错） */
function parseUidsLoose(json) {
  try {
    const obj = JSON.parse(json || '{}')
    const out = {}
    for (const [k, v] of Object.entries(obj || {})) {
      if (k === '_meta') continue
      if (Array.isArray(v)) out[k] = v.filter(Boolean).map(String)
    }
    return out
  } catch {
    return {}
  }
}


export class SignService extends Service {

  dbService = autowired('dbService')

  adminService = autowired('adminService')

  constructor(app) {
    super(app)
    const pluginsRoot = path.dirname(_paths.pluginRoot || path.join(_paths.data, '..', 'plugins'))
    this.filePath = path.join(pluginsRoot, 'Lotus-Plugin', 'data', 'audit', 'checkin.jsonl')
    this._cache = null
    this._cacheKey = ''
  }

  /** 数据结构版本，便于前端判断 */
  get available() {
    try {
      return fs.existsSync(this.filePath)
    } catch {
      return false
    }
  }

  /** 读取并解析流水（按 mtime+size 缓存） */
  _load() {
    if (!this.available) {
      return {records: [], meta: {available: false, path: this.filePath}}
    }
    let stat
    try {
      stat = fs.statSync(this.filePath)
    } catch {
      return {records: [], meta: {available: false, path: this.filePath}}
    }
    const key = `${stat.mtimeMs}:${stat.size}`
    if (this._cache && this._cacheKey === key) {
      return this._cache
    }

    let lines = []
    try {
      lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    } catch (e) {
      globalThis.logger?.warn?.(`[sign] 读取签到流水失败：${e.message}`)
    }

    const records = []
    for (const line of lines) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const games = parseGames(row.message)
      const coins = parseCoins(row.message)
      records.push({
        time: row.time,
        date: dateOf(row.time),
        qq: String(row.qq || ''),
        profileId: Number(row.profileId || 1),
        ok: Boolean(row.ok),
        stage: row.stage || '',
        source: row.source || 'manual',
        message: String(row.message || ''),
        games,
        coins,
      })
    }
    records.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))

    const lastAt = records.length ? records[records.length - 1].time : null
    const dates = [...new Set(records.map((r) => r.date))].sort()

    const parsed = {
      records,
      meta: {
        available: true,
        path: this.filePath,
        fileSize: stat.size,
        lines: records.length,
        firstDate: dates[0] || null,
        lastDate: dates[dates.length - 1] || null,
        lastAt,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      },
    }
    this._cache = parsed
    this._cacheKey = key
    return parsed
  }

  /** 单日聚合 */
  _aggDay(list) {
    const users = new Set()
    const accounts = new Set()
    let ok = 0
    let fail = 0
    let coinSum = 0
    let coinCnt = 0
    let maxDays = 0
    const gameStat = {}
    for (const g of GAMES) {
      gameStat[g.key] = {signed: 0, unbound: 0, failed: 0}
    }

    for (const r of list) {
      users.add(r.qq)
      accounts.add(`${r.qq}|${r.profileId}`)
      if (r.ok) {
        ok += 1
      } else {
        fail += 1
      }
      if (r.coins?.current != null) {
        coinSum += r.coins.current
        coinCnt += 1
      }
      for (const g of r.games) {
        const bucket = gameStat[g.key]
        if (!bucket) {
          continue
        }
        if (g.status === 'signed') {
          bucket.signed += 1
        } else if (g.status === 'unbound') {
          bucket.unbound += 1
        } else if (g.status === 'failed') {
          bucket.failed += 1
        }
        if (g.days && g.days > maxDays) {
          maxDays = g.days
        }
      }
    }
    return {
      total: list.length,
      ok,
      fail,
      users: users.size,
      accounts: accounts.size,
      gameStat,
      coinAvg: coinCnt ? Math.round(coinSum / coinCnt) : 0,
      coinTotal: coinSum,
      maxDays,
    }
  }

  /** 概览：今日 + 近 N 天趋势 + 游戏矩阵 + 最近流水 */
  getOverview(days = 14) {
    const {records, meta} = this._load()
    if (!meta.available) {
      return {
        available: false,
        meta,
        today: null,
        trend: [],
        games: [],
        matrix: {dates: [], games: []},
        recent: [],
      }
    }

    const byDate = new Map()
    for (const r of records) {
      if (!byDate.has(r.date)) {
        byDate.set(r.date, [])
      }
      byDate.get(r.date).push(r)
    }
    const allDates = [...byDate.keys()].sort()
    const span = Math.max(1, Math.min(120, Number(days) || 14))
    const windowDates = allDates.slice(-span)

    const trend = windowDates.map((d) => {
      const agg = this._aggDay(byDate.get(d))
      return {
        date: d,
        total: agg.total,
        ok: agg.ok,
        fail: agg.fail,
        users: agg.users,
        accounts: agg.accounts,
        coinAvg: agg.coinAvg,
        maxDays: agg.maxDays,
      }
    })

    const todayDate = allDates[allDates.length - 1] || null
    const todayList = todayDate ? byDate.get(todayDate) : []
    const todayAgg = this._aggDay(todayList)
    const today = todayDate
      ? {
          date: todayDate,
          ...todayAgg,
          rate: todayAgg.total ? Math.round((todayAgg.ok / todayAgg.total) * 1000) / 10 : 0,
        }
      : null

    // 游戏维度（今日）
    const games = GAMES.map((g) => {
      const st = todayAgg.gameStat[g.key] || {signed: 0, unbound: 0, failed: 0}
      const base = st.signed + st.unbound + st.failed
      return {
        key: g.key,
        label: g.label,
        color: g.color,
        signed: st.signed,
        unbound: st.unbound,
        failed: st.failed,
        rate: base ? Math.round((st.signed / base) * 1000) / 10 : 0,
      }
    })

    // 游戏 × 天 矩阵（最近 N 天各游戏签到人数）
    const matrix = {
      dates: windowDates,
      games: GAMES.map((g) => ({
        key: g.key,
        label: g.label,
        color: g.color,
        values: windowDates.map((d) => (this._aggDay(byDate.get(d)).gameStat[g.key]?.signed) || 0),
      })),
    }

    const recent = records.slice(-8).reverse().map((r) => ({
      time: r.time,
      qq: r.qq,
      ok: r.ok,
      source: r.source,
      stage: r.stage,
      games: r.games.map((g) => ({key: g.key, status: g.status, days: g.days})),
      message: r.message.slice(0, 200),
    }))

    return {
      available: true,
      meta,
      today,
      trend,
      games,
      matrix,
      recent,
      summary: {
        days: allDates.length,
        records: records.length,
        users: new Set(records.map((r) => r.qq)).size,
        avgOkRate: (() => {
          const ok = records.filter((r) => r.ok).length
          return records.length ? Math.round((ok / records.length) * 1000) / 10 : 0
        })(),
      },
    }
  }

  /** 明细查询：日期 / 关键字 / 成败 / 游戏状态 */
  queryRecords({date = '', q = '', ok = '', game = '', status = '', page = 1, size = 20} = {}) {
    const {records} = this._load()
    const kw = String(q || '').trim().toLowerCase()
    let list = records
    if (date) {
      list = list.filter((r) => r.date === String(date))
    }
    if (ok === 'ok' || ok === '1' || ok === true) {
      list = list.filter((r) => r.ok)
    } else if (ok === 'fail' || ok === '0' || ok === false) {
      list = list.filter((r) => !r.ok)
    }
    if (game) {
      const gk = String(game)
      const st = String(status || 'signed')
      list = list.filter((r) => r.games.some((g) => g.key === gk && (st === 'any' || g.status === st)))
    }
    if (kw) {
      list = list.filter(
        (r) => r.qq.toLowerCase().includes(kw) || r.message.toLowerCase().includes(kw) || r.date.includes(kw),
      )
    }

    const total = list.length
    const p = Math.max(1, Number(page) || 1)
    const s = Math.min(200, Math.max(5, Number(size) || 20))
    const start = (p - 1) * s
    const rows = list
      .slice()
      .reverse()
      .slice(start, start + s)
      .map((r) => ({
        time: r.time,
        date: r.date,
        qq: r.qq,
        profileId: r.profileId,
        ok: r.ok,
        stage: r.stage,
        source: r.source,
        coins: r.coins,
        games: r.games,
        message: r.message,
      }))
    return {total, page: p, size: s, list: rows}
  }

  /** 某一天的完整聚合（含游戏明细 + 账号列表）
   *
   * 账号粒度 = (qq, profileId)：一个微信号可以绑多个米游社账号（profileId 1/2/3…），
   * 它们的成功数、连续天数、米游币必须各算各的，不能合并成一行。
   */
  getDay(date) {
    const {records} = this._load()
    const d = String(date || '').slice(0, 10)
    const list = d ? records.filter((r) => r.date === d) : []
    if (list.length === 0) {
      return {date: d, available: false, list: [], userList: [], accountList: [], failList: []}
    }
    const agg = this._aggDay(list)

    const labelOf = (key) => GAMES.find((g) => g.key === key)?.label || key
    const nameMap = (() => {
      try {
        const m = this.adminService?._nameMap?.()
        return m instanceof Map ? m : new Map()
      } catch {
        return new Map()
      }
    })()
    const accountMap = new Map()

    for (const r of list) {
      const key = `${r.qq}|${r.profileId}`
      const prev = accountMap.get(key) || {
        qq: r.qq,
        profileId: r.profileId,
        accountNo: r.profileId,
        count: 0,
        ok: 0,
        fail: 0,
        days: 0,
        coins: null,
        games: {},
        signedGames: [],
        unboundGames: [],
        failedGames: [],
        failReasons: [],
        firstAt: r.time,
        lastAt: r.time,
      }
      prev.count += 1
      if (r.time < prev.firstAt) prev.firstAt = r.time
      if (r.time > prev.lastAt) prev.lastAt = r.time
      if (r.ok) {
        prev.ok += 1
      } else {
        prev.fail += 1
      }
      if (r.coins?.current != null) {
        prev.coins = r.coins.current
      }

      let hasFailedGame = false
      for (const g of r.games) {
        if (g.status === 'signed') {
          prev.games[g.key] = g.days || 0
          if ((g.days || 0) > prev.days) {
            prev.days = g.days || 0
          }
          if (!prev.signedGames.includes(g.key)) {
            prev.signedGames.push(g.key)
          }
        } else if (g.status === 'failed') {
          hasFailedGame = true
          if (!prev.failedGames.includes(g.key)) {
            prev.failedGames.push(g.key)
          }
          prev.failReasons.push({
            game: g.key,
            label: labelOf(g.key),
            kind: 'failed',
            reason: g.text || '签到失败',
          })
        } else if (g.status === 'unbound') {
          if (!prev.unboundGames.includes(g.key)) {
            prev.unboundGames.push(g.key)
          }
          prev.failReasons.push({
            game: g.key,
            label: labelOf(g.key),
            kind: 'unbound',
            reason: g.text || '并没有绑定该游戏账号',
          })
        }
      }

      // 整轮失败但没有任何游戏段落说明原因时，用 stage / message 兜底
      if (!r.ok && !hasFailedGame) {
        const brief = String(r.message || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        prev.failReasons.push({
          game: '',
          label: r.stage || '整轮',
          kind: 'record',
          reason: brief || (r.stage ? `执行中断于 ${r.stage}` : '未返回具体原因'),
        })
      }

      accountMap.set(key, prev)
    }

    const accountList = [...accountMap.values()]
      .map((a) => ({
        ...a,
        name: String(nameMap.get(String(a.qq)) || ''),
        allOk: a.fail === 0,
        // 去重同一条原因（同一游戏多次失败只留一条）
        failReasons: a.failReasons.filter(
          (x, i, arr) => arr.findIndex((y) => y.game === x.game && y.kind === x.kind && y.reason === x.reason) === i,
        ),
        signedLabels: a.signedGames.map(labelOf),
        unboundLabels: a.unboundGames.map(labelOf),
        failedLabels: a.failedGames.map(labelOf),
      }))
      .sort((a, b) => b.fail - a.fail || a.qq.localeCompare(b.qq) || a.profileId - b.profileId)

    // 兼容旧前端：按微信号再聚合一层（不参与新展示）
    const userMap = new Map()
    for (const a of accountList) {
      const prev = userMap.get(a.qq) || {qq: a.qq, name: a.name, count: 0, ok: 0, fail: 0, days: 0, coins: null, games: {}, accounts: 0, accountNos: []}
      prev.count += a.count
      prev.ok += a.ok
      prev.fail += a.fail
      prev.accounts += 1
      prev.accountNos.push(a.profileId)
      prev.days = Math.max(prev.days, a.days)
      if (a.coins != null) prev.coins = a.coins
      Object.assign(prev.games, a.games)
      userMap.set(a.qq, prev)
    }

    // 「失败」只算真正签到失败（fail > 0）；单纯「没绑某游戏」不算失败，但计入 reasonAccounts
    const failedAccounts = accountList.filter((a) => a.fail > 0)
    const failList = failedAccounts.map((a) => ({
      qq: a.qq,
      name: a.name,
      profileId: a.profileId,
      accountNo: a.accountNo,
      lastAt: a.lastAt,
      fail: a.fail,
      failReasons: a.failReasons,
    }))

    return {
      date: d,
      available: true,
      ...agg,
      rate: agg.total ? Math.round((agg.ok / agg.total) * 1000) / 10 : 0,
      accountList,
      userList: [...userMap.values()].sort((a, b) => b.ok - a.ok || b.days - a.days),
      failList,
      failAccounts: failedAccounts.length,
      reasonAccounts: accountList.filter((a) => a.failReasons.length > 0).length,
      multiAccountUsers: [...userMap.values()].filter((u) => u.accounts > 1).length,
    }
  }

  /* ------------------------------ 异常账号清单 ------------------------------ */

  /**
   * 体检：CK 失效账号 / 无绑定（或悬空绑定）用户 / 近 N 天持续失败账号
   *
   * 只读，不修改任何数据；返回结构给前端勾选后调 cleanIssues。
   * @param {{days?:number, limit?:number}} opts
   */
  getIssues({days = 7, limit = 300} = {}) {
    const span = Math.max(1, Math.min(60, Number(days) || 7))
    const cap = Math.max(20, Math.min(1000, Number(limit) || 300))
    const result = {
      generatedAt: new Date().toISOString(),
      days: span,
      expired: [],
      orphan: [],
      stale: [],
      counts: {expired: 0, orphan: 0, stale: 0},
    }

    const admin = (() => {
      try {
        return this.dbService.getAdminDb()
      } catch {
        return null
      }
    })()
    const bot = (() => {
      try {
        return this.dbService.getBotDb()
      } catch {
        return null
      }
    })()

    const nameMap = (() => {
      try {
        const map = this.adminService?._nameMap?.()
        return map instanceof Map ? map : new Map()
      } catch {
        return new Map()
      }
    })()
    const bindMap = (() => {
      try {
        return this.adminService?._bindMap?.() || new Map()
      } catch {
        return new Map()
      }
    })()

    const mysRows = []
    if (bot) {
      try {
        mysRows.push(...bot.prepare('SELECT ltuid, uids, ck FROM MysUsers').all())
      } catch {
        /* 主库不可读时降级 */
      }
    }
    const mysMap = new Map(mysRows.map((r) => [Number(r.ltuid), r]))

    /* ---- 1. CK 失效账号 ---- */
    if (admin) {
      try {
        const rows = admin
          .prepare("SELECT ltuid, ck_status, checked_at FROM account_status WHERE ck_status = 'expired' ORDER BY checked_at DESC")
          .all()
        for (const row of rows) {
          const ltuid = Number(row.ltuid)
          const mys = mysMap.get(ltuid)
          const uids = mys ? parseUidsLoose(mys.uids) : {}
          const bindIds = bindMap.get(ltuid) || []
          result.expired.push({
            ltuid,
            checkedAt: row.checked_at || null,
            uidCount: Object.values(uids).reduce((n, arr) => n + (arr?.length || 0), 0),
            games: Object.entries(uids)
              .filter(([, arr]) => arr?.length)
              .map(([k, arr]) => `${GAMES.find((g) => g.key === k)?.label || k}×${arr.length}`),
            bindIds,
            bindNames: bindIds.map((id) => nameMap.get(id) || ''),
            exists: !!mys,
          })
        }
      } catch (e) {
        globalThis.logger?.warn?.(`[sign] 读取 CK 状态失败：${e.message}`)
      }
    }

    /* ---- 2. 无绑定 / 悬空绑定用户 ---- */
    if (bot) {
      try {
        const users = bot.prepare('SELECT id, name, ltuids FROM Users').all()
        for (const u of users) {
          const raw = String(u.ltuids || '').trim()
          const ids = raw
            ? raw
                .split(',')
                .map((x) => Number(String(x).trim()))
                .filter(Boolean)
            : []
          const missing = ids.filter((id) => !mysMap.has(id))
          if (ids.length === 0) {
            result.orphan.push({
              id: String(u.id),
              name: String(u.name || ''),
              kind: 'empty',
              ltuids: [],
              dangling: [],
              reason: '没有任何绑定账号',
            })
          } else if (missing.length === ids.length) {
            result.orphan.push({
              id: String(u.id),
              name: String(u.name || ''),
              kind: 'dangling',
              ltuids: ids,
              dangling: missing,
              reason: `绑定的 ${missing.length} 个账号都已不存在`,
            })
          } else if (missing.length > 0) {
            result.orphan.push({
              id: String(u.id),
              name: String(u.name || ''),
              kind: 'partial',
              ltuids: ids,
              dangling: missing,
              reason: `有 ${missing.length} 个绑定已失效（保留 ${ids.length - missing.length} 个有效）`,
            })
          }
        }
      } catch (e) {
        globalThis.logger?.warn?.(`[sign] 读取用户绑定失败：${e.message}`)
      }
    }

    /* ---- 3. 近 N 天持续失败账号（只列不建议自动删） ---- */
    try {
      const {records} = this._load()
      if (records.length) {
        const dates = [...new Set(records.map((r) => r.date))].sort()
        const tail = dates.slice(-span)
        const cutoff = tail[0] || ''
        const byAccount = new Map()
        for (const r of records) {
          if (r.date < cutoff) continue
          const key = `${r.qq}|${r.profileId}`
          const prev = byAccount.get(key) || {
            qq: r.qq,
            profileId: r.profileId,
            total: 0,
            ok: 0,
            fail: 0,
            lastAt: r.time,
            lastOk: false,
            lastReasons: [],
          }
          prev.total += 1
          if (r.ok) prev.ok += 1
          else prev.fail += 1
          if (r.time >= prev.lastAt) {
            prev.lastAt = r.time
            prev.lastOk = r.ok
            prev.lastReasons = r.games
              .filter((g) => g.status === 'failed' || g.status === 'unbound')
              .map((g) => `${GAMES.find((x) => x.key === g.key)?.label || g.key}：${g.text || (g.status === 'unbound' ? '未绑定' : '签到失败')}`)
            if (!prev.lastReasons.length && !r.ok) {
              prev.lastReasons = [String(r.message || '').replace(/\s+/g, ' ').slice(0, 120) || '未返回原因']
            }
          }
          byAccount.set(key, prev)
        }
        for (const a of byAccount.values()) {
          if (a.fail === 0) continue
          result.stale.push({
            qq: a.qq,
            profileId: a.profileId,
            days: tail.length,
            total: a.total,
            ok: a.ok,
            fail: a.fail,
            allFail: a.ok === 0,
            lastAt: a.lastAt,
            lastOk: a.lastOk,
            reasons: a.lastReasons,
            name: String(nameMap.get(String(a.qq)) || ''),
          })
        }
        result.stale.sort((a, b) => Number(b.allFail) - Number(a.allFail) || b.fail - a.fail || b.lastAt.localeCompare(a.lastAt))
        result.stale = result.stale.slice(0, cap)
      }
    } catch (e) {
      globalThis.logger?.warn?.(`[sign] 统计失败账号出错：${e.message}`)
    }

    result.expired = result.expired.slice(0, cap)
    result.orphan = result.orphan.slice(0, cap)
    result.counts = {
      expired: result.expired.length,
      orphan: result.orphan.length,
      stale: result.stale.length,
      orphanEmpty: result.orphan.filter((o) => o.kind === 'empty').length,
      orphanDangling: result.orphan.filter((o) => o.kind !== 'empty').length,
      staleAllFail: result.stale.filter((o) => o.allFail).length,
    }
    return result
  }

}
