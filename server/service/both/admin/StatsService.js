import {autowired, Service} from '#guoba.framework'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 插件数据 / 群数据 统计服务（Redis 聚合）
 *
 * 数据来源全部是 Redis 只读操作，不触碰 Bot 主库，不改任何键。
 * 所有聚合结果带内存缓存，避免每次请求都全量 SCAN。
 *
 * 已知命名空间（本机实测 51,943 keys）：
 *   Yz:count:*        45,400  消息计数（按 天/用户/群）   string
 *   miao:rank:*        5,126  miao 排行（含 @chatroom 群榜）
 *   Yz:cache:*         4,944  米游社 API 缓存
 *   miao:profile:*     2,679  米游社档案缓存
 *   CHATGPT:MESSAGE:*  1,409  AI 会话
 *   Yz:GMx:*             387  群管增强·日总计
 *   MysAPI:*            ~500  米游社 API 层
 *   Yz:group_id:*        235  用户→群映射
 *   Yz:GM:*              112  群管增强·活跃榜（zset）
 */

/** 命名空间展示元信息 */
const NS_META = [
  {ns: 'Yz:count', label: '消息计数', owner: '云崽核心', desc: '按天记录的收/发消息量，是群与用户活跃度的基础数据'},
  {ns: 'miao:rank', label: '排行数据', owner: 'miao-plugin', desc: '米游社面板角色排行，含 @chatroom 群内排行榜'},
  {ns: 'miao:profile', label: '玩家档案', owner: 'miao-plugin', desc: '米游社玩家信息快照，按游戏分区'},
  {ns: 'Yz:cache', label: 'API 缓存', owner: '云崽核心', desc: '米游社接口查询结果缓存，按游戏分区'},
  {ns: 'CHATGPT', label: 'AI 会话', owner: 'ChatGPT 插件', desc: '大模型对话上下文与配置索引'},
  {ns: 'Yz:GMx', label: '群日总计', owner: '群管增强', desc: '群消息日汇总，用于活跃统计'},
  {ns: 'MysAPI', label: '米游社接口', owner: 'MysAPI 层', desc: 'Cookie / 设备指纹等接口态数据'},
  {ns: 'Yz:group_id', label: '群映射', owner: '云崽核心', desc: '用户与群/会话的关联关系'},
  {ns: 'Yz:GM', label: '活跃榜', owner: '群管增强', desc: '群成员活跃度排行（日/周/月/年）'},
  {ns: 'ark-plugin', label: '崩铁深渊', owner: 'ark-plugin', desc: '深渊战绩与排名'},
  {ns: 'ZZZ', label: '绝区零面板', owner: 'ZZZ-Plugin', desc: '绝区零角色面板缓存'},
  {ns: 'deepseekJS', label: '角色扮演', owner: 'DeepSeek 插件', desc: '群角色扮演会话状态'},
  {ns: 'deepseek', label: '角色扮演', owner: 'DeepSeek 插件', desc: '群角色扮演配置'},
  {ns: 'yenai', label: '椰奶配置', owner: 'yenai-plugin', desc: '插件合并配置缓存'},
  {ns: 'xiaoyao', label: '逍遥数据', owner: 'xiaoyao-plugin', desc: '插件业务数据'},
  {ns: 'Yz:waves', label: '鸣潮数据', owner: 'waves-plugin', desc: '鸣潮面板与抽卡数据'},
  {ns: 'Yz:wavesJs', label: '鸣潮数据', owner: 'waves-plugin', desc: '鸣潮面板与抽卡数据'},
  {ns: 'Yunzai', label: '核心运行态', owner: '云崽核心', desc: '运行时状态标记'},
  {ns: 'Yz:other', label: '其他核心数据', owner: '云崽核心', desc: '核心杂项运行数据'},
]

/**
 * 把 Redis key 归并成命名空间（两级为主）
 * Yz:count:send:msg:...  ->  Yz:count
 * miao:rank:group-...    ->  miao:rank
 * CHATGPT:MESSAGE:xxx    ->  CHATGPT
 */
function nsOf(key) {
  const p = key.split(':')
  const head = p[0]
  if (head === 'miao') return p.length >= 2 ? `miao:${p[1]}` : 'miao'
  if (head === 'Yz') {
    if (p.length < 2) return 'Yz'
    // waves 系列统一到一个桶
    if (p[1] === 'wavesJs') return 'Yz:wavesJs'
    return `Yz:${p[1]}`
  }
  if (head === 'Yunzai') return p.length >= 2 ? `Yunzai:${p[1]}` : 'Yunzai'
  if (head === 'CHATGPT') return 'CHATGPT'
  if (head === 'deepseekJS') return 'deepseekJS'
  if (head === 'deepseek') return 'deepseek'
  return head
}

/** 游戏代码映射 */
export const GAME_LABEL = {
  gs: '原神',
  sr: '星穹铁道',
  zzz: '绝区零',
  bh3: '崩坏3',
  bh2: '崩坏2',
  wd: '未定事件簿',
}

const CACHE_TTL = {
  histogram: 3 * 60 * 1000,
  groups: 60 * 1000,
  trend: 60 * 1000,
  users: 60 * 1000,
}

export class StatsService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    this._cache = new Map()
  }

  /* ------------------------------ 基础设施 ------------------------------ */

  get redis() {
    return globalThis.redis ?? null
  }

  /**
   * 带 TTL 的内存缓存，并对并发请求做去重
   * 首屏会同时请求 overview / groups / trend / games，若各自触发全库 SCAN 会重复扫多遍。
   *
   * keep(val)：可选。返回 false 视为「预热期结果」（如 Bot.gl 还没挂上、群列表被过滤成空），
   * 只缓存 3 秒而不是整个 TTL —— 否则重启后 60 秒内打开的页面会一直看到「暂无群数据」。
   */
  async _cached(name, ttl, fn, keep = null) {
    const hit = this._cache.get(name)
    const now = Date.now()
    if (hit) {
      if (hit.pending) return hit.pending
      if (now - hit.at < (hit.ttl ?? ttl)) return hit.val
    }
    const pending = Promise.resolve()
      .then(fn)
      .then((val) => {
        const use = keep && !keep(val) ? Math.min(ttl, 3 * 1000) : ttl
        this._cache.set(name, {at: Date.now(), val, ttl: use})
        return val
      })
      .catch((e) => {
        this._cache.delete(name)
        throw e
      })
    this._cache.set(name, {at: now, pending})
    return pending
  }

  /** 兼容 node-redis v3 / v4 的 SCAN 封装 */
  async _scan(pattern, limit = 200000) {
    const client = this.redis
    const keys = []
    let cursor = '0'
    let guard = 0
    do {
      const res = await client.scan(cursor, {MATCH: pattern, COUNT: 1000})
      if (Array.isArray(res)) {
        cursor = String(res[0])
        keys.push(...res[1])
      } else {
        cursor = String(res.cursor)
        keys.push(...res.keys)
      }
      guard++
    } while (cursor !== '0' && guard < 400 && keys.length < limit)
    return keys
  }

  /** 分批 mGet，避免单条命令过大 */
  async _mget(keys, chunk = 800) {
    const client = this.redis
    const out = []
    for (let i = 0; i < keys.length; i += chunk) {
      const part = keys.slice(i, i + chunk)
      const vals = await client.mGet(part)
      for (let j = 0; j < part.length; j++) out.push([part[j], vals[j]])
    }
    return out
  }

  /**
   * 简单节流缓存：大屏 2 秒轮询下，磁盘/日志这类「变化慢 + 同步 IO」的项没必要每次都读。
   * 仅用于同步函数（不缓存 Promise）。
   */
  _throttle(key, ttl, fn) {
    const now = Date.now()
    this._thr ??= {}
    const hit = this._thr[key]
    if (hit && hit.until > now) return hit.val
    const val = fn()
    this._thr[key] = {val, until: now + ttl}
    return val
  }

  _today() {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /** 归一化群号：去掉 WX 适配器的 group- 前缀，统一成 123@chatroom */
  _normGid(raw) {
    if (!raw) return ''
    return String(raw).replace(/^group-/, '')
  }

  /** 遍历所有 Bot 实例（Bot 以 uin 为键，gl/gml/fl 都挂在实例上） */
  _iterBots() {
    const out = []
    try {
      const Bot = globalThis.Bot
      if (!Bot) return out
      for (const v of Object.values(Bot)) {
        if (v && typeof v === 'object' && (v.gl || v.gml || v.fl)) out.push(v)
      }
      // 兼容把 gl 直接挂在 Bot 上的实现
      if (typeof Bot.gl?.forEach === 'function' && !out.includes(Bot)) out.push(Bot)
    } catch {
      /* 忽略 */
    }
    return out
  }

  _groupList() {
    // 运行时优先读 Bot 内存群列表（有群名），拿不到就退回群号
    // 注意：过滤字面 'null'/'undefined'（部分适配器会吐这种值），已退群的群不在此 Map 中
    const map = new Map()
    try {
      for (const b of this._iterBots()) {
        const gl = b?.gl
        if (!gl || typeof gl.forEach !== 'function') continue
        gl.forEach((g, k) => {
          const gid = this._normGid(g?.group_id ?? g?.groupId ?? k)
          if (!gid) return
          const raw = g?.group_name ?? g?.groupName
          const nm = typeof raw === 'string' ? raw.trim() : ''
          map.set(gid, nm && nm !== 'null' && nm !== 'undefined' ? nm : '')
        })
      }
    } catch {
      /* 忽略 */
    }
    return map
  }

  /* --------------------------- 命名空间直方图 --------------------------- */

  /**
   * 全库键空间直方图：一级前缀 + 细分前缀 + 键类型 + 样例
   * 用途：插件数据总览页
   */
  async getHistogram(force = false) {
    return this._cached('histogram', CACHE_TTL.histogram, async () => {
      const client = this.redis
      if (!client) return {available: false, totalKeys: 0, buckets: [], scannedAt: null}

      const dbsize = await client.dbSize()
      const keys = await this._scan('*')

      const bucketMap = new Map() // ns -> count
      const subMap = new Map() // ns -> Map(sub -> count)
      const sampleMap = new Map() // ns -> string[]

      for (const key of keys) {
        const ns = nsOf(key)
        bucketMap.set(ns, (bucketMap.get(ns) || 0) + 1)

        const p = key.split(':')
        if (p.length >= 3) {
          const sub = `${p[0]}:${p[1]}:${p[2]}`
          if (!subMap.has(ns)) subMap.set(ns, new Map())
          const m = subMap.get(ns)
          m.set(sub, (m.get(sub) || 0) + 1)
        }

        // 每个桶最多留 8 个样例用于类型探测
        const arr = sampleMap.get(ns) || []
        if (arr.length < 8) arr.push(key)
        sampleMap.set(ns, arr)
      }

      // 一次性 pipeline 探测所有样例类型
      const typeMap = new Map()
      try {
        const allSamples = []
        for (const [, arr] of sampleMap) allSamples.push(...arr)
        if (allSamples.length) {
          const multi = client.multi()
          for (const k of allSamples) multi.type(k)
          const res = await multi.exec()
          allSamples.forEach((k, i) => typeMap.set(k, res[i]))
        }
      } catch {
        /* 类型探测失败不影响主流程 */
      }

      const buckets = []
      for (const [ns, count] of [...bucketMap.entries()].sort((a, b) => b[1] - a[1])) {
        const meta = NS_META.find((m) => m.ns === ns) ?? null
        const subs = subMap.get(ns)
        const detail = subs
          ? [...subs.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([k, v]) => ({key: k, count: v}))
          : []
        const samples = sampleMap.get(ns) ?? []

        const types = {}
        for (const s of samples) {
          const t = typeMap.get(s) || 'unknown'
          types[t] = (types[t] || 0) + 1
        }

        buckets.push({
          ns,
          keys: count,
          ratio: keys.length ? Number(((count / keys.length) * 100).toFixed(2)) : 0,
          label: meta?.label ?? ns,
          owner: meta?.owner ?? '其他 / 未知',
          desc: meta?.desc ?? '',
          known: !!meta,
          types,
          detail,
          samples: samples.slice(0, 2),
        })
      }

      return {
        available: true,
        totalKeys: keys.length,
        dbsize,
        bucketCount: buckets.length,
        knownCount: buckets.filter((b) => b.known).length,
        scannedAt: new Date().toISOString(),
        buckets,
      }
    })
  }

  /* ------------------------------ 群数据 ------------------------------ */

  /**
   * 群聚合：消息量（收/发）、最近活跃日、活跃榜人数、排行参与人数、绑定用户数
   * 数据源：Yz:count:*:msg:group:* / Yz:GM:active* / Yz:GMx:dayTotal:* / miao:rank:*@chatroom* / Yz:group_id:*
   * @param {boolean} force 跳过缓存
   * @param {{includeLeft?: boolean}} opts includeLeft=true 时保留 Bot 已退群的残留数据群
   *   （默认隐藏——清理过的/已退群的群不再出现在后台列表，无效群检测用 true 取全量）
   */
  async _aggregateGroups(force = false, opts = {}) {
    const includeLeft = opts?.includeLeft === true
    const cacheKey = includeLeft ? 'groups:all' : 'groups'
    return this._cached(cacheKey, CACHE_TTL.groups, async () => {
      const client = this.redis
      if (!client) return {available: false, groups: [], trend: []}

      const recvKeys = await this._scan('Yz:count:receive:msg:group:*')
      const sendKeys = await this._scan('Yz:count:send:msg:group:*')

      const gmap = new Map() // gid -> record
      const trendMap = new Map() // date -> {recv, send}
      const ensure = (gid) => {
        let r = gmap.get(gid)
        if (!r) {
          r = {gid, recv: 0, send: 0, total: 0, days: 0, lastDate: '', daily: new Map()}
          gmap.set(gid, r)
        }
        return r
      }

      const parse = (key, dir) => {
        // Yz:count:receive:msg:group:<gid>:YYYY:MM:DD
        const parts = key.split(':')
        if (parts.length < 8) return null
        const gid = this._normGid(parts[5])
        const date = `${parts[6]}-${parts[7]}-${parts[8] ?? ''}`.replace(/-$/, '')
        if (!gid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
        // raw = 键里的原始群号（可能带 group- 前缀），重建键时必须用它，否则会漏读
        return {gid, raw: parts[5], date, dir}
      }

      const recvParsed = recvKeys.map((k) => [k, parse(k, 'recv')]).filter(([, p]) => p)
      const sendParsed = sendKeys.map((k) => [k, parse(k, 'send')]).filter(([, p]) => p)

      const allParsed = [...recvParsed, ...sendParsed]
      const fetched = await this._mget(allParsed.map(([k]) => k))
      const valMap = new Map(fetched)

      for (const [key, p] of allParsed) {
        const n = Number(valMap.get(key)) || 0
        if (!n) continue
        const r = ensure(p.gid)
        // 同一 gid 可能有多种键形态（ComWeChat 的 group- 前缀改过版），历史数据散在两把键里，
        // 只记第一把会看运气：碰上死形态，今日计数就永远读 0。全部记下，读取时逐形态求和。
        if (p.raw) {
          if (!r.rawGid) r.rawGid = p.raw
          ;(r.rawForms ??= new Set()).add(p.raw)
        }
        r[p.dir] += n
        r.total += n
        r.days += 1
        if (p.date > r.lastDate) r.lastDate = p.date
        r.daily.set(p.date, (r.daily.get(p.date) || 0) + n)

        const t = trendMap.get(p.date) || {date: p.date, recv: 0, send: 0, total: 0}
        t[p.dir] += n
        t.total += n
        trendMap.set(p.date, t)
      }

      // 群管活跃榜（zset）：取今日/本周/本月/最新
      try {
        const gmKeys = await this._scan('Yz:GM:active*')
        for (const key of gmKeys) {
          const slot = key.split(':')[2] || '' // activeD / activeW / activeM / activeN / active
          const gidPart = key.split(':').pop()
          const gid = this._normGid(gidPart)
          if (!gid || !gid.includes('@chatroom')) continue
          const r = ensure(gid)
          const n = await client.zCard(key).catch(() => 0)
          if (!r.active) r.active = {}
          const name = slot.replace(/^active/, '') || 'all'
          r.active[name] = Math.max(r.active[name] || 0, Number(n) || 0)
        }
      } catch {
        /* 忽略 */
      }

      // 群管日总计
      try {
        const dayKeys = await this._scan('Yz:GMx:dayTotal:*')
        const pairs = await this._mget(dayKeys)
        for (const [key, v] of pairs) {
          const parts = key.split(':')
          const date = parts[3]
          const gid = this._normGid(parts[4])
          if (!gid) continue
          const r = ensure(gid)
          if (!r.dayTotalDate || date > r.dayTotalDate) {
            r.dayTotalDate = date
            r.dayTotal = Number(v) || 0
          }
        }
      } catch {
        /* 忽略 */
      }

      // miao 排行参与人数（按群统计 key 数）
      try {
        const rankKeys = await this._scan('miao:rank:*@chatroom*')
        for (const key of rankKeys) {
          // miao:rank:<gid>:<type>:<id>  或  miao:rank:group-<gid>:...
          const parts = key.split(':')
          const gid = this._normGid(parts[2] || '')
          if (!gid.includes('@chatroom')) continue
          const r = ensure(gid)
          r.rankKeys = (r.rankKeys || 0) + 1
        }
      } catch {
        /* 忽略 */
      }

      // 绑定用户数：Yz:group_id:<wxid> -> gid
      try {
        const bindKeys = await this._scan('Yz:group_id:*')
        const pairs = await this._mget(bindKeys)
        for (const [, v] of pairs) {
          const gid = this._normGid(String(v || '').split(':')[0])
          if (!gid.includes('@chatroom')) continue
          const r = ensure(gid)
          r.boundUsers = (r.boundUsers || 0) + 1
        }
      } catch {
        /* 忽略 */
      }

      const nameMap = this._groupList()
      const groups = [...gmap.values()].map((r) => {
        const dailyArr = [...r.daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        return {
          gid: r.gid,
          /** Redis 键里的原始群号；重建计数键时用它 */
          rawGid: r.rawGid || r.gid,
          /** 该 gid 出现过的所有键形态（含历史），getLive 逐形态求和用 */
          rawGids: r.rawForms && r.rawForms.size ? [...r.rawForms] : [r.rawGid || r.gid],
          name: nameMap.get(r.gid) || '',
          // nameMap 的 key 即运行时在群集合：false = Bot 已不在该群（无群名属正常）
          inGroup: nameMap.has(r.gid),
          recv: r.recv,
          send: r.send,
          total: r.total,
          activeDays: r.days,
          lastDate: r.lastDate,
          active: r.active || {},
          dayTotal: r.dayTotal ?? 0,
          dayTotalDate: r.dayTotalDate ?? null,
          rankKeys: r.rankKeys ?? 0,
          boundUsers: r.boundUsers ?? 0,
          avgDaily: r.days ? Math.round(r.total / r.days) : 0,
          daily: dailyArr.slice(-14).map(([date, n]) => ({date, n})),
        }
      })

      groups.sort((a, b) => b.total - a.total)

      // 默认隐藏 Bot 已退群的残留群（清不清理都不再出现在后台群列表）
      const visible = includeLeft ? groups : groups.filter((g) => nameMap.has(g.gid))

      const trend = [...trendMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
      // 预热期：Redis 里有计数数据，但 Bot.gl 还没挂上（适配器没连完）→ visible 被过滤成空。
      // 这种结果按 60s 长缓存的话，重启后打开的页面会一直「暂无群数据」，所以只缓 3 秒。
      const warming = groups.length > 0 && visible.length === 0
      return {available: true, groups: visible, trend, warming, updatedAt: new Date().toISOString()}
    }, (val) => !val?.warming)
  }

  /** 群列表（分页 + 关键词 + 排序） */
  async queryGroups({keyword = '', sort = 'total', order = 'desc', page = 1, size = 20} = {}) {
    const agg = await this._aggregateGroups()
    if (!agg.available) {
      return {available: false, total: 0, page: 1, size, list: [], trend: []}
    }
    let list = agg.groups
    if (keyword) {
      const kw = String(keyword).toLowerCase()
      list = list.filter(
        (g) => g.gid.toLowerCase().includes(kw) || (g.name || '').toLowerCase().includes(kw),
      )
    }
    const dir = order === 'asc' ? 1 : -1
    const key = ['total', 'recv', 'send', 'lastDate', 'activeDays', 'avgDaily', 'rankKeys', 'boundUsers'].includes(sort)
      ? sort
      : 'total'
    list = [...list].sort((a, b) => {
      const va = a[key]
      const vb = b[key]
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb)) * dir
      }
      return ((va || 0) - (vb || 0)) * dir
    })

    const total = list.length
    const p = Math.max(1, Number(page) || 1)
    const s = Math.min(100, Math.max(1, Number(size) || 20))
    return {
      available: true,
      total,
      page: p,
      size: s,
      updatedAt: agg.updatedAt,
      summary: this._groupSummary(agg.groups),
      list: list.slice((p - 1) * s, p * s),
      trend: agg.trend,
    }
  }

  _groupSummary(groups) {
    const today = this._today()
    let todayMsg = 0
    let totalMsg = 0
    let activeToday = 0
    for (const g of groups) {
      totalMsg += g.total
      const d = g.daily.find((x) => x.date === today)
      if (d) {
        todayMsg += d.n
        activeToday += 1
      }
    }
    return {
      groupCount: groups.length,
      todayMsg,
      totalMsg,
      activeToday,
      avgPerGroup: groups.length ? Math.round(totalMsg / groups.length) : 0,
    }
  }

  /** 单群详情 */
  async getGroupDetail(gid) {
    const agg = await this._aggregateGroups()
    const target = this._normGid(gid)
    const g = agg.groups?.find((x) => x.gid === target)
    if (!g) return {available: false, gid: target}

    // 活跃榜 TOP（兼容 Redis 5，用 ZREVRANGE 而非 ZRANGE ... REV）
    let top = []
    let topSlot = ''
    try {
      const client = this.redis
      const prefer = ['N', 'D', 'W', 'M', '']
      for (const slot of prefer) {
        const keys = await this._scan(`Yz:GM:active${slot}:*${target}`)
        if (keys.length) {
          const latest = keys.sort().pop()
          let rows = []
          try {
            rows = await client.sendCommand(['ZREVRANGE', latest, '0', '19', 'WITHSCORES'])
          } catch {
            rows = []
          }
          // 返回扁平数组 [member, score, member, score...]
          if (Array.isArray(rows) && rows.length) {
            const flat = []
            for (let i = 0; i < rows.length; i += 2) {
              flat.push({user: String(rows[i]), score: Math.round(Number(rows[i + 1]) || 0)})
            }
            top = flat
            topSlot = slot || 'all'
          }
          if (top.length) break
        }
      }
    } catch {
      /* 忽略 */
    }

    /* 活跃榜补昵称，前端就不用再显示脱敏 wxid */
    if (top.length) {
      const names = this._userNameMap()
      top = top.map((t) => ({...t, name: names.get(t.user) || ''}))
    }

    return {available: true, ...g, top, topSlot}
  }

  /** 全局消息趋势（按天） */
  async getTrend(days = 14) {
    const agg = await this._aggregateGroups()
    const trend = (agg.trend || []).slice(-Math.max(1, Math.min(120, Number(days) || 14)))
    return {available: agg.available, trend, updatedAt: agg.updatedAt}
  }

  /* ------------------------------ 用户数据 ------------------------------ */

  /**
   * 用户聚合：消息量（收/发）、活跃天数、首末活跃日、逐日趋势
   * 数据源：Yz:count:{receive,send}:msg:user:<uid>:{total|YYYY|YYYY:MM|YYYY:MM:DD}
   * 键分级：total=终身、YYYY=年、YYYY:MM=月、YYYY:MM:DD=日
   * 终身量只读 :total 键（避免与日/月键重复累计），趋势只读日键。
   */
  async _aggregateUsers(force = false) {
    return this._cached('users', CACHE_TTL.users, async () => {
      const client = this.redis
      if (!client) return {available: false, users: new Map(), trend: [], userTrend: []}

      const recvKeys = await this._scan('Yz:count:receive:msg:user:*')
      const sendKeys = await this._scan('Yz:count:send:msg:user:*')

      const umap = new Map() // uid -> record
      const ensure = (uid) => {
        let r = umap.get(uid)
        if (!r) {
          r = {uid, recvTotal: 0, sendTotal: 0, days: new Set(), daily: new Map(), months: new Map()}
          umap.set(uid, r)
        }
        return r
      }

      // 解析键尾段：['total'] / ['YYYY'] / ['YYYY','MM'] / ['YYYY','MM','DD']
      // Yz:count:<dir>:msg:user:<uid>:<tail...>  → parts[5] 是 uid
      const parse = (key) => {
        const parts = key.split(':')
        if (parts.length < 7) return null
        const uid = parts[5]
        const tail = parts.slice(6)
        if (tail.length === 1 && tail[0] === 'total') return {uid, kind: 'total'}
        if (tail.length === 1 && /^\d{4}$/.test(tail[0])) return {uid, kind: 'year', date: tail[0]}
        if (tail.length === 2 && /^\d{4}$/.test(tail[0]) && /^\d{2}$/.test(tail[1])) {
          return {uid, kind: 'month', date: `${tail[0]}-${tail[1]}`}
        }
        if (tail.length === 3 && /^\d{4}$/.test(tail[0]) && /^\d{2}$/.test(tail[1]) && /^\d{2}$/.test(tail[2])) {
          return {uid, kind: 'day', date: `${tail[0]}-${tail[1]}-${tail[2]}`}
        }
        return null
      }

      const parsed = [
        ...recvKeys.map((k) => [k, parse(k), 'recv']),
        ...sendKeys.map((k) => [k, parse(k), 'send']),
      ].filter(([, p]) => p)

      const fetched = await this._mget(parsed.map(([k]) => k))
      const valMap = new Map(fetched)

      const globalTrend = new Map() // date -> {recv, send}（用户维度全局趋势）

      for (const [key, p, dir] of parsed) {
        const n = Number(valMap.get(key)) || 0
        if (!n) continue
        const r = ensure(p.uid)
        if (p.kind === 'total') {
          r[`${dir}Total`] = n
        } else if (p.kind === 'day') {
          r.days.add(p.date)
          r.daily.set(p.date, (r.daily.get(p.date) || 0) + n)
          const t = globalTrend.get(p.date) || {date: p.date, recv: 0, send: 0}
          t[dir] += n
          globalTrend.set(p.date, t)
        } else if (p.kind === 'month') {
          r.months.set(p.date, (r.months.get(p.date) || 0) + n)
        }
        // year 级不单独累计（可用月级推导）
      }

      const users = [...umap.values()]
      const trend = [...globalTrend.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
      return {available: true, users, trend, updatedAt: new Date().toISOString()}
    })
  }

  /**
   * 用户统计页 hero 聚合：总用户 / 绑定率 / 近 7 天活跃与新增 / 今日活跃 / 7 日趋势
   * 数据来自 Users + MysUsers（bot.db）与用户消息聚合（Redis）。
   */
  async getUserHero(force = false) {
    const bot = this.dbService?.getBotDb?.() || null
    let totalUsers = 0
    let boundUsers = 0
    if (bot) {
      try {
        totalUsers = bot.prepare('SELECT COUNT(*) AS n FROM Users').get().n
        boundUsers = bot.prepare("SELECT COUNT(*) AS n FROM Users WHERE ltuids IS NOT NULL AND ltuids <> ''").get().n
      } catch {}
    }

    const agg = await this._aggregateUsers(force)
    const names = this._userNameMap()
    const day = 86400000
    const pad = (n) => String(n).padStart(2, '0')
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const today = ymd(new Date())
    const since7 = ymd(new Date(Date.now() - 6 * day))

    let active7 = 0
    let new7 = 0
    let activeToday = 0
    const spark = []
    if (agg.available) {
      for (const r of agg.users) {
        const dates = [...r.daily.keys()].sort()
        const first = dates[0] || ''
        const last = dates[dates.length - 1] || ''
        if (last >= since7) active7++
        if (first && first >= since7) new7++
        if (last === today) activeToday++
      }
      // 近 7 天逐日消息
      for (let i = 6; i >= 0; i--) {
        const d = ymd(new Date(Date.now() - i * day))
        const hit = (agg.trend || []).find((t) => t.date === d)
        spark.push({date: d, total: hit ? (hit.recv || 0) + (hit.send || 0) : 0})
      }
    }

    const msg7 = spark.reduce((n, s) => n + s.total, 0)
    const yesterday = spark.length > 1 ? spark[spark.length - 2].total : 0

    // 最活跃用户 TOP5
    let top = []
    if (agg.available) {
      top = [...agg.users]
        .map((r) => ({
          uid: r.uid,
          name: names.get(r.uid) || '',
          total: r.recvTotal + r.sendTotal,
          activeDays: r.days.size,
          lastDate: [...r.daily.keys()].sort().pop() || '',
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5)
    }

    return {
      available: agg.available,
      users: {total: totalUsers, bound: boundUsers, bindRate: totalUsers ? Math.round((boundUsers / totalUsers) * 100) : 0},
      active: {today: activeToday, last7: active7, new7},
      message: {today: spark[spark.length - 1]?.total || 0, yesterday, last7: msg7},
      spark,
      top,
      updatedAt: new Date().toISOString(),
    }
  }

  /** 用户列表（分页 + 关键词 + 排序），self=只看 bot 自己发送 */
  async queryUsers({keyword = '', sort = 'total', order = 'desc', page = 1, size = 20, scope = 'all'} = {}) {
    const agg = await this._aggregateUsers()
    if (!agg.available) {
      return {available: false, total: 0, page: 1, size, list: [], summary: {}, trend: []}
    }
    let list = agg.users.map((r) => {
      const dailyArr = [...r.daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      const dates = dailyArr.map(([d]) => d)
      return {
        uid: r.uid,
        recv: r.recvTotal,
        send: r.sendTotal,
        total: r.recvTotal + r.sendTotal,
        activeDays: r.days.size,
        firstDate: dates[0] || '',
        lastDate: dates[dates.length - 1] || '',
        avgDaily: r.days.size ? Math.round((r.recvTotal + r.sendTotal) / r.days.size) : 0,
      }
    })

    // 用 Bot 好友列表尽力补昵称（拿不到就空着）
    const names = this._userNameMap()
    if (names.size) {
      for (const u of list) u.name = names.get(u.uid) || ''
    } else {
      for (const u of list) u.name = ''
    }

    if (keyword) {
      const kw = String(keyword).toLowerCase()
      list = list.filter((u) => u.uid.toLowerCase().includes(kw) || (u.name || '').toLowerCase().includes(kw))
    }

    const dir = order === 'asc' ? 1 : -1
    const key = ['total', 'recv', 'send', 'activeDays', 'lastDate', 'avgDaily', 'firstDate'].includes(sort) ? sort : 'total'
    list = [...list].sort((a, b) => {
      const va = a[key]
      const vb = b[key]
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb)) * dir
      }
      return ((va || 0) - (vb || 0)) * dir
    })

    const total = list.length
    const p = Math.max(1, Number(page) || 1)
    const s = Math.min(100, Math.max(1, Number(size) || 20))
    return {
      available: true,
      total,
      page: p,
      size: s,
      updatedAt: agg.updatedAt,
      summary: this._userSummary(list),
      trend: agg.trend.slice(-30),
      list: list.slice((p - 1) * s, p * s),
    }
  }

  _userSummary(list) {
    const today = this._today()
    let totalMsg = 0
    let activeToday = 0
    for (const u of list) {
      totalMsg += u.total
      if (u.lastDate === today) activeToday += 1
    }
    return {
      userCount: list.length,
      totalMsg,
      activeToday,
      avgPerUser: list.length ? Math.round(totalMsg / list.length) : 0,
    }
  }

  /* 对外公开的映射（其它 service 复用，别各自再扫一遍 Bot 内存） */

  /** uid -> 昵称 */
  userNameMap() {
    return this._userNameMap()
  }

  /** gid -> 群名（拿不到为 ''） */
  groupNameMap() {
    return this._groupList()
  }

  /**
   * 昵称映射（uid -> 昵称）
   * 数据源优先级：好友备注 > 好友昵称 > 群名片 > 群昵称
   * ComWeChat 下 Users 表 name 全为空、用户也大多不是好友，
   * 所以必须扫 Bot.gml 的群成员列表，才能拿到 wxid 对应的真实昵称
   */
  _userNameMap() {
    const now = Date.now()
    if (this._nameCache && now - this._nameCache.at < 60000) return this._nameCache.map
    const live = new Map()
    const put = (k, v) => {
      const key = String(k ?? '').trim()
      const name = String(v ?? '').trim()
      if (!key || !name) return
      if (!live.has(key)) live.set(key, name)
    }
    try {
      for (const b of this._iterBots()) {
        if (b?.fl && typeof b.fl.forEach === 'function') {
          b.fl.forEach((u, k) => put(k, u?.remark || u?.nickname || u?.name))
        }
        const gml = b?.gml
        if (gml && typeof gml.forEach === 'function') {
          gml.forEach((members) => {
            if (!members || typeof members.forEach !== 'function') return
            members.forEach((m, k) => {
              put(
                m?.user_id ?? m?.uin ?? k,
                m?.card || m?.group_nickname || m?.user_displayname || m?.nickname || m?.name || m?.user_name,
              )
            })
          })
        }
      }
    } catch {
      /* 忽略 */
    }

    /* 内存里拿到的先落库，Bot 重启后仍然可查 */
    if (live.size) this._persistNames(live)

    /* 再用历史快照兜底（内存里没有再补） */
    const map = new Map(live)
    try {
      const db = this.dbService?.getAdminDb?.()
      if (db) {
        for (const row of db.prepare('SELECT uid, name FROM user_name').all()) {
          if (!map.has(row.uid)) map.set(row.uid, row.name)
        }
      }
    } catch {
      /* 忽略 */
    }

    this._nameCache = {at: now, map}
    return map
  }

  /**
   * 昵称回写 admin.db（节流 5 分钟）
   * 数据源是 Bot 运行时内存，落库后后台/重启后都能显示昵称
   */
  _persistNames(map) {
    const now = Date.now()
    if (this._persistAt && now - this._persistAt < 300_000) return
    this._persistAt = now
    try {
      const db = this.dbService?.getAdminDb?.()
      if (!db) return
      const stmt = db.prepare(`
        INSERT INTO user_name (uid, name, source, updated_at) VALUES (?, ?, 'bot-memory', ?)
        ON CONFLICT(uid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
      `)
      const ts = new Date().toISOString()
      db.transaction((entries) => {
        for (const [k, v] of entries) stmt.run(k, v, ts)
      })([...map.entries()])
    } catch {
      /* 忽略：昵称只是展示增强，失败不影响统计 */
    }
  }

  /** 对外暴露昵称映射（供 UID 列表等场景使用） */
  getUserNameMap() {
    return this._userNameMap()
  }

  /** 单用户详情：总量、逐日（近30）、逐月（近12）、首末活跃 */
  async getUserDetail(uid) {
    const agg = await this._aggregateUsers()
    const target = String(uid || '').trim()
    const r = agg.users?.find((x) => x.uid === target)
    if (!r) return {available: false, uid: target}

    const names = this._userNameMap()
    const dailyArr = [...r.daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const monthArr = [...r.months.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const dates = dailyArr.map(([d]) => d)
    return {
      available: true,
      uid: r.uid,
      name: names.get(r.uid) || '',
      recv: r.recvTotal,
      send: r.sendTotal,
      total: r.recvTotal + r.sendTotal,
      activeDays: r.days.size,
      firstDate: dates[0] || '',
      lastDate: dates[dates.length - 1] || '',
      avgDaily: r.days.size ? Math.round((r.recvTotal + r.sendTotal) / r.days.size) : 0,
      daily: dailyArr.slice(-30).map(([date, n]) => ({date, n})),
      monthly: monthArr.slice(-12).map(([date, n]) => ({date, n})),
    }
  }

  /* ---------------------------- 游戏维度分布 ---------------------------- */

  /** 从 Yz:cache / miao:profile 的二级前缀抽取游戏分布 */
  async getGameDistribution() {
    const hist = await this.getHistogram()
    if (!hist.available) return {available: false, cache: [], profile: []}

    const pick = (ns, subPrefix) => {
      const bucket = hist.buckets.find((b) => b.ns === ns)
      if (!bucket) return []
      return bucket.detail
        .filter((d) => d.key.startsWith(subPrefix))
        .map((d) => {
          const code = d.key.slice(subPrefix.length)
          return {game: code, label: GAME_LABEL[code] || code, count: d.count}
        })
        .filter((x) => GAME_LABEL[x.game])
        .sort((a, b) => b.count - a.count)
    }

    return {
      available: true,
      cache: pick('Yz:cache', 'Yz:cache:'),
      profile: pick('miao:profile', 'miao:profile:'),
    }
  }

  /* ---------------------------- 总览聚合卡片 ---------------------------- */

  async getOverviewCards() {
    const [hist, groups] = await Promise.all([this.getHistogram(), this._aggregateGroups()])
    const summary = this._groupSummary(groups.groups || [])
    return {
      available: hist.available,
      redisKeys: hist.dbsize ?? hist.totalKeys ?? 0,
      namespaces: hist.bucketCount ?? 0,
      ...summary,
      scannedAt: hist.scannedAt,
      updatedAt: groups.updatedAt ?? null,
    }
  }

  /** 供 SyncService / 无效群检测复用：群快照（不受内存缓存影响，含已退群残留） */
  async snapshotGroups() {
    const agg = await this._aggregateGroups(true, {includeLeft: true})
    return agg.groups || []
  }

  /**
   * 实时脉冲（大屏 2~3 秒轮询专用）。
   *
   * 为什么不用 getOverviewCards：它要 SCAN 全库（5 万键约 120ms）+ 60 秒缓存，
   * 高频调用既贵又「不快」。这里直接按群读今日/累计计数键：
   *   Yz:count:{receive|send}:msg:group:<rawGid>:{YYYY:MM:DD|total}
   * 群号清单取自 60 秒缓存的群聚合 → 稳态下只有 1 次 MGET + 1 次 DBSIZE，亚毫秒级。
   * 口径与 _groupSummary 完全一致（同一批键），不会出现两个数打架。
   */
  async getLive() {
    const client = this.redis
    const at = new Date().toISOString()
    if (!client) {
      return {available: false, day: this._today(), todayMsg: 0, todayRecv: 0, todaySend: 0,
        totalMsg: 0, activeToday: 0, groups: {}, redisKeys: 0, at}
    }

    const day = this._today().replace(/-/g, ':')
    let groups = []
    try {
      const agg = await this._aggregateGroups()
      groups = agg?.groups || []
    } catch {
      groups = []
    }

    // 今日键：同一 gid 的所有键形态都要读（历史形态可能还活着，只读一把会漏）
    const keys = []
    const owner = []
    groups.forEach((g, gi) => {
      const forms = Array.isArray(g.rawGids) && g.rawGids.length ? g.rawGids : [g.rawGid || g.gid]
      for (const raw of forms) {
        keys.push(`Yz:count:receive:msg:group:${raw}:${day}`)
        owner.push(gi)
        keys.push(`Yz:count:send:msg:group:${raw}:${day}`)
        owner.push(gi)
      }
    })

    let valMap = new Map()
    if (keys.length) {
      try {
        valMap = new Map(await this._mget(keys))
      } catch {
        valMap = new Map()
      }
    }

    // ⚠️ 累计口径：不能用 Yz:count:*:msg:group:<gid>:total 这个粒度键 ——
    // 它和「按日键累加」不是一回事（清空统计工具只清一边时会出现 60 vs 一年历史的荒谬差），
    // 实测 total 键合计 33.6 万、按日键合计 38.9 万。这里的 totalMsg 直接取群聚合缓存里的
    // g.total（即 overview 同源口径），代价为零，最多滞后一次缓存轮换（60s）。
    let todayMsg = 0
    let todayRecv = 0
    let todaySend = 0
    let totalMsg = 0
    let activeToday = 0
    const byGroup = {}
    const acc = groups.map(() => 0)
    for (let i = 0; i < keys.length; i++) {
      const n = Number(valMap.get(keys[i])) || 0
      if (!n) continue
      acc[owner[i]] += n
      todayMsg += n
      if (i % 2 === 0) todayRecv += n
      else todaySend += n
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]
      byGroup[g.gid] = acc[gi]
      if (acc[gi] > 0) activeToday += 1
      totalMsg += Number(g.total) || 0
    }

    let redisKeys = 0
    try {
      redisKeys = await client.dbSize()
    } catch {
      /* 忽略 */
    }

    return {
      available: true,
      day: this._today(),
      todayMsg,
      todayRecv,
      todaySend,
      totalMsg,
      activeToday,
      groups: byGroup,
      redisKeys,
      at,
    }
  }

  /* ---------------------------- 机器人运行时状态（状态大屏） ---------------------------- */

  /**
   * 机器人本体运行状态：系统 / 进程 / Redis / 在线账号。
   * 全部只读；CPU 占用用两次请求间的采样差值计算（不阻塞、不缓存）。
   */
  async getRuntime() {
    const memTotal = os.totalmem()
    const memFree = os.freemem()
    const memUsed = memTotal - memFree
    const proc = process.memoryUsage()

    // CPU 占用：与上次采样做差（首次请求返回 null，前端按未知处理）
    let idle = 0
    let total = 0
    const cpus = os.cpus()
    for (const c of cpus) {
      idle += c.times.idle
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    }
    let cpuUsage = null
    if (this._lastCpu && total > this._lastCpu.total) {
      const raw = (1 - (idle - this._lastCpu.idle) / (total - this._lastCpu.total)) * 100
      // 大屏 2 秒采一次，原始差值抖动大；做一次指数平滑让指针稳一点（仍能反映突变）
      this._cpuEma = this._cpuEma == null ? raw : this._cpuEma * 0.45 + raw * 0.55
      cpuUsage = Math.round(this._cpuEma * 10) / 10
    }
    this._lastCpu = {idle, total}

    // Redis：键数 + 版本。版本号恒定，取到一次就不再请求（高频轮询下省一条命令）
    let redisKeys = 0
    let redisVersion = null
    const client = this.redis
    if (client) {
      try {
        redisKeys = await client.dbSize()
        if (!this._redisVer) {
          const info = await client.info('server')
          const m = /redis_version:([\d.]+)/.exec(info || '')
          if (m) this._redisVer = m[1]
        }
        redisVersion = this._redisVer || null
      } catch {}
    }

    // 在线账号（适配器结构不统一，字段全部兜底）
    //
    // ⚠️ 踩坑记录（两次）：
    // ① Bot.bots 里多数条目是 adapter 注册的空壳，Object.values 会得到一堆「未知适配器」；
    // ② 反过来用 Object.entries 的 key 兜底更糟 —— Bot.bots 自身带 url/logger/xlogin
    //    这类内部属性，会被当成账号显示出来。
    // 结论：以 Bot.uin 集合为准（内核维护的权威在线列表），bots 只用来补昵称/平台。
    const uinList = Array.from(globalThis.Bot?.uin || [])
      .map((u) => String(u ?? '').trim())
      .filter(Boolean)
    const botsMap = globalThis.Bot?.bots
    const pickBot = (uin) => (botsMap instanceof Map ? botsMap.get(uin) : botsMap?.[uin])
    const adapterList = Array.isArray(globalThis.Bot?.adapter)
      ? globalThis.Bot.adapter.map((a) => ({id: String(a?.id || ''), name: String(a?.name || '')}))
      : []
    // Bot.bots 自身不会出现在 uin 集合里，但为兼容「uin 集合为空」的老内核，再做一次 entries 兜底
    const fallbackEntries = (botsMap instanceof Map ? [...botsMap.entries()] : Object.entries(botsMap || {})).filter(
      ([, b]) => b && typeof b === 'object' && (b.uin || b.stat || b.fl || b.gl),
    )

    const resolvePlatform = (b, uin) => {
      const a = b?.adapter
      let platform = null
      if (typeof a === 'string') platform = a
      else if (a && typeof a === 'object') platform = a.name || a.id || null
      if (!platform) platform = b?.platform || null
      if (!platform) {
        const hit = adapterList.find((x) => x.id && (x.id === uin || String(b?.adapter?.id || '') === x.id))
        platform = hit?.name || null
      }
      return platform ? String(platform) : null
    }

    let botList = uinList.map((uin) => {
      const b = pickBot(uin) || {}
      return {
        uin,
        nickname: String(b?.nickname ?? b?.account?.nickname ?? b?.bot?.nickname ?? '').trim(),
        platform: resolvePlatform(b, uin),
        status: b?.stat?.status ?? null,
        // 出现在 Bot.uin 集合里即视为在线（这是内核的权威在线列表）
        online: true,
      }
    })

    if (!botList.length && fallbackEntries.length) {
      botList = fallbackEntries
        .map(([key, b]) => {
          const uin = String(b?.uin ?? b?.account?.uin ?? b?.bot?.uin ?? key ?? '').trim()
          return {
            uin,
            nickname: String(b?.nickname ?? b?.account?.nickname ?? b?.bot?.nickname ?? '').trim(),
            platform: resolvePlatform(b, uin),
            status: b?.stat?.status ?? null,
            online: b?.stat?.online === 2 || !!b?.stat?.start_time || !!uin,
          }
        })
        .filter((b) => b.uin && b.uin !== 'undefined' && b.uin !== 'null')
    }

    // 同 uin 去重，避免多 adapter 重复注册
    const seen = new Set()
    botList = botList.filter((b) => (seen.has(b.uin) ? false : (seen.add(b.uin), true)))

    return {
      available: !!client,
      updatedAt: new Date().toISOString(),
      system: {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        osRelease: `${os.type()} ${os.release()}`,
        cpuModel: cpus[0]?.model?.trim() ?? '',
        /** os.cpus().length 是逻辑核心（含超线程），Node 无物理核 API，前端须标「逻辑核心」 */
        cpuCores: cpus.length,
      },
      nodeVersion: process.version,
      /** 锅巴随 Bot 主进程加载，process.uptime 即 Bot 运行时长（秒） */
      botUptime: Math.round(process.uptime()),
      osUptime: Math.round(os.uptime()),
      cpuUsage,
      memory: {
        total: memTotal,
        used: memUsed,
        free: memFree,
        usagePct: memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : 0,
        rss: proc.rss,
        heapUsed: proc.heapUsed,
        heapTotal: proc.heapTotal,
        /** 堆使用率：接近 90% 预示 OOM，大屏单独展示 */
        heapPct: proc.heapTotal ? Math.round((proc.heapUsed / proc.heapTotal) * 1000) / 10 : 0,
      },
      disk: this._throttle('disk', 10 * 1000, () => this._readDisk()),
      /** AI 引擎用量（读 YingAI 落盘文件，插件未装/当日无调用返回 null） */
      ai: this._readAiUsage(),
      logs: this._throttle('logs', 5 * 1000, () => this._readLogs()),
      redis: {keys: redisKeys, version: redisVersion},
      bots: botList,
    }
  }

  /**
   * 磁盘占用。Windows 上 statfsSync 对 cwd 可用；失败返回 null（前端显 N/A，不要显 0）。
   */
  _readDisk() {
    try {
      if (typeof fs.statfsSync !== 'function') return null
      const st = fs.statfsSync(process.cwd())
      const total = st.blocks * st.bsize
      const free = st.bavail * st.bsize
      return {total, free, used: Math.max(0, total - free), usagePct: total ? Math.round(((total - free) / total) * 1000) / 10 : 0}
    } catch {
      return null
    }
  }

  /**
   * AI 用量。直接读 YingAI/data/usage/_global.json，不 import 该插件代码（解耦，未装即 null）。
   *
   * ⚠️ 口径坑：Usage.js 只在「写入时」按 _day 清零，直接读文件拿到的是最后一次写入的快照。
   * 若 _day 不是今天，说明今天还没有任何模型调用 —— 必须按 0 处理，否则会把昨天的量当今日。
   */
  _readAiUsage() {
    try {
      const file = path.resolve(process.cwd(), 'plugins/YingAI/data/usage/_global.json')
      if (!fs.existsSync(file)) return null
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const d = new Date()
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
      const isToday = String(raw?._day || '') === today
      const t = raw?.total || {}
      const byModel = Object.entries(raw?.byModel || {})
        .map(([model, v]) => ({model, calls: Number(v?.calls) || 0, total: Number(v?.total) || 0}))
        .sort((a, b) => b.calls - a.calls)
      return {
        day: raw?._day ?? null,
        isToday,
        calls: isToday ? Number(t.calls) || 0 : 0,
        prompt: isToday ? Number(t.prompt) || 0 : 0,
        completion: isToday ? Number(t.completion) || 0 : 0,
        total: isToday ? Number(t.total) || 0 : 0,
        byModel: isToday ? byModel : [],
        rateLimit: {
          hits: Number(raw?.rateLimit?.hits) || 0,
          lastAt: Number(raw?.rateLimit?.lastAt) || 0,
        },
      }
    } catch {
      return null
    }
  }

  /** 日志体积与最后写入时间（只 stat，不读内容） */
  _readLogs() {
    const out = {errorSize: null, errorMtime: null, todaySize: null}
    const dir = path.resolve(process.cwd(), 'logs')
    try {
      const st = fs.statSync(path.join(dir, 'error.log'))
      out.errorSize = st.size
      out.errorMtime = st.mtime.toISOString()
    } catch {}
    try {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      const name = `command.${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`
      out.todaySize = fs.statSync(path.join(dir, name)).size
    } catch {}
    return out
  }
}
