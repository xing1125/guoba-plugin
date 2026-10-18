import fs from 'node:fs'
import path from 'node:path'
import {Service} from '#guoba.framework'
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

export class SignService extends Service {

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

  /** 某一天的完整聚合（含游戏明细 + 用户列表） */
  getDay(date) {
    const {records} = this._load()
    const d = String(date || '').slice(0, 10)
    const list = d ? records.filter((r) => r.date === d) : []
    if (list.length === 0) {
      return {date: d, available: false, list: []}
    }
    const agg = this._aggDay(list)
    const userMap = new Map()
    for (const r of list) {
      const prev = userMap.get(r.qq) || {qq: r.qq, count: 0, ok: 0, fail: 0, days: 0, coins: null, games: {}}
      prev.count += 1
      if (r.ok) {
        prev.ok += 1
      } else {
        prev.fail += 1
      }
      if (r.coins?.current != null) {
        prev.coins = r.coins.current
      }
      for (const g of r.games) {
        if (g.status === 'signed') {
          prev.games[g.key] = g.days || 0
          if ((g.days || 0) > prev.days) {
            prev.days = g.days || 0
          }
        }
      }
      userMap.set(r.qq, prev)
    }
    return {
      date: d,
      available: true,
      ...agg,
      rate: agg.total ? Math.round((agg.ok / agg.total) * 1000) / 10 : 0,
      userList: [...userMap.values()].sort((a, b) => b.ok - a.ok || b.days - a.days),
    }
  }
}
