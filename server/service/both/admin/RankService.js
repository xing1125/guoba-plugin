import fs from 'node:fs'
import path from 'node:path'
import {Service, autowired} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 群战力榜（miao-plugin 的排名数据）
 *
 * miao 把每群每个角色的排名存在 zset 里：
 *   miao:rank:<groupId>:<type>:<charId>   zset(uid -> 分数)
 *   miao:rank:uid-info:<uid>              {qq, uidType, totalCount...}  —— uid → wxid/qq
 *
 * type 有 dmg(伤害) / mark(评分) / crit / valid，实际有数据的基本只有 dmg 和 mark。
 * charId 原神是 8 位（10000052），星铁是 4 位（1306），两套 id 不会撞。
 *
 * 角色名与星级从 miao 的 meta 里读（resources/meta-{gs,sr}/character/data.json），
 * 读不到就退化显示 id —— miao 没装或改了结构也不会让页面崩。
 */

const RANK_KEY_RE = /^miao:rank:(.+):(dmg|mark|crit|valid):(\d+)$/

const TYPE_LABEL = {
  dmg: '伤害',
  mark: '评分',
  crit: '暴击',
  valid: '有效词条',
}

/** 榜单参与的角色少的类型不值得出现在选择器里 */
const MIN_CHARS = 1

const CACHE_TTL = 60_000

/** Redis 里 gid 可能带 `group-` 前缀，Bot 内存里也两种都有；统一去掉再比 */
const normGid = (gid) => String(gid ?? '').replace(/^group-/, '').trim()

/**
 * 对外展示用的更严格归一：再去掉 `@chatroom`
 * 只用在新增的统计接口里 —— board()/listGroups() 的 gid 一直带 `@chatroom`，不能动
 */
const displayGid = (gid) => normGid(gid).replace(/@chatroom$/, '')

export class RankService extends Service {

  statsService = autowired('statsService')

  constructor(app) {
    super(app)
    const pluginsRoot = path.dirname(_paths.pluginRoot || path.join(_paths.data, '..', 'plugins'))
    this.miaoRoot = path.join(pluginsRoot, 'miao-plugin', 'resources')
    this._chars = null
    this._scanCache = null
    this._aggCache = null
  }

  get redis() {
    return globalThis.redis ?? null
  }

  get available() {
    try {
      return !!this.redis && fs.existsSync(this.miaoRoot)
    } catch {
      return false
    }
  }

  /* ------------------------------ 角色元数据 ------------------------------ */

  /** charId -> {id, name, abbr, game, star, elem} */
  _charMeta() {
    if (this._chars) return this._chars
    const map = new Map()
    for (const [game, dir] of [
      ['gs', 'meta-gs'],
      ['sr', 'meta-sr'],
    ]) {
      try {
        const file = path.join(this.miaoRoot, dir, 'character', 'data.json')
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        const list = Array.isArray(raw) ? raw : Object.values(raw)
        for (const c of list) {
          if (!c?.id) continue
          map.set(String(c.id), {
            id: String(c.id),
            name: String(c.name || c.abbr || c.id),
            abbr: String(c.abbr || ''),
            game,
            star: Number(c.star) || 0,
            elem: String(c.elem || ''),
          })
        }
      } catch {
        /* miao 没装 / 结构变了：退化成 id */
      }
    }
    this._chars = map
    return map
  }

  /* ------------------------------ 键扫描 ------------------------------ */

  /** 扫一遍所有 rank 键并解析成分组结构，60 秒内复用 */
  async _scanRank(force = false) {
    const now = Date.now()
    if (!force && this._scanCache && now - this._scanCache.at < CACHE_TTL) return this._scanCache.data

    const client = this.redis
    if (!client) return {groups: new Map(), totalKeys: 0}

    const keys = []
    let cursor = '0'
    let guard = 0
    do {
      const res = await client.scan(cursor, {MATCH: 'miao:rank:*', COUNT: 1000})
      if (Array.isArray(res)) {
        cursor = String(res[0])
        keys.push(...res[1])
      } else {
        cursor = String(res.cursor)
        keys.push(...res.keys)
      }
      guard++
    } while (cursor !== '0' && guard < 200)

    // gid -> {gid, chars: Map<type, Set<charId>>, rawKeys, rawAll, rawGids}
    //
    // 同一个群在 Redis 里可能同时存在 `gid` 与 `group-gid` 两种前缀（两者内容并不相同），
    // 靠 gid 反拼 key 对 `group-` 那批群根本拿不到数据，所以原始键必须原样留住：
    //   rawKeys  'type:charId' -> 原始键（第一个遇到的，代表键）
    //   rawAll   'type:charId' -> 原始键数组（两种前缀并存时会有两个）
    //   rawGids  原始 gid 前缀 -> 该前缀下的键数
    const groups = new Map()
    for (const key of keys) {
      const m = RANK_KEY_RE.exec(key)
      if (!m) continue
      const rawGid = m[1]
      const gid = normGid(rawGid)
      const type = m[2]
      const charId = m[3]
      if (!gid) continue
      let g = groups.get(gid)
      if (!g) {
        g = {gid, chars: new Map(), rawKeys: new Map(), rawAll: new Map(), rawGids: new Map()}
        groups.set(gid, g)
      }
      if (!g.chars.has(type)) g.chars.set(type, new Set())
      g.chars.get(type).add(charId)

      const pair = `${type}:${charId}`
      if (!g.rawKeys.has(pair)) g.rawKeys.set(pair, key)
      if (!g.rawAll.has(pair)) g.rawAll.set(pair, [])
      g.rawAll.get(pair).push(key)
      g.rawGids.set(rawGid, (g.rawGids.get(rawGid) || 0) + 1)
    }

    const data = {groups, totalKeys: keys.length}
    this._scanCache = {at: now, data}
    return data
  }

  /* ------------------------------ 群列表 ------------------------------ */

  async listGroups(force = false) {
    if (!this.available) return {available: false, groups: []}
    const {groups} = await this._scanRank(force)
    const nameMap = this.statsService.groupNameMap()
    const chars = this._charMeta()

    const list = [...groups.values()].map((g) => {
      const types = {}
      for (const [type, set] of g.chars) {
        if (set.size >= MIN_CHARS) types[type] = set.size
      }
      // 只保留真正有数据、且角色能对上的榜（避免全是 id 的脏数据）
      const total = Object.values(types).reduce((a, b) => a + b, 0)
      return {
        gid: g.gid,
        name: nameMap.get(g.gid) || nameMap.get(`group-${g.gid}`) || '',
        types,
        total,
        charCount: Math.max(0, ...[...g.chars.values()].map((s) => s.size)),
      }
    })

    list.sort((a, b) => b.total - a.total)
    return {
      available: true,
      groups: list,
      charMeta: chars.size,
      scannedAt: new Date().toISOString(),
    }
  }

  /* ------------------------------ 榜单 ------------------------------ */

  /**
   * @param {object} opts
   * @param {string} opts.gid     群号（可带 group- 前缀）
   * @param {string} opts.type    dmg | mark
   * @param {string} opts.charId  角色 id，空则自动选参与人数最多的角色
   * @param {number} opts.limit   取前 N 名（默认 20，最多 100）
   */
  async board({gid, type = 'dmg', charId = '', limit = 20} = {}) {
    if (!this.available) return {available: false, reason: 'miao-plugin 未安装或 Redis 未就绪'}

    const {groups} = await this._scanRank()
    const normed = normGid(gid)
    /* groups 的键是「去掉 group- 前缀」的形式，通常仍带 @chatroom；
       前端/外部若只传裸群号，补一次 @chatroom 再找，避免直接落到「没有排行数据」 */
    const group = groups.get(normed) || (normed && !normed.endsWith('@chatroom') ? groups.get(`${normed}@chatroom`) : undefined)
    if (!group) {
      return {available: true, empty: true, reason: '这个群还没有排行数据', rows: [], chars: []}
    }

    const meta = this._charMeta()
    const nameMap = this.statsService.groupNameMap()

    // 该群有数据的类型
    const types = [...group.chars.entries()]
      .filter(([, set]) => set.size >= MIN_CHARS)
      .map(([key, set]) => ({key, label: TYPE_LABEL[key] || key, chars: set.size}))
      .sort((a, b) => (b.chars || 0) - (a.chars || 0))

    if (!types.length) return {available: true, empty: true, reason: '这个群还没有排行数据', rows: [], chars: []}

    const activeType = types.some((t) => t.key === type) ? type : types[0].key
    const charSet = group.chars.get(activeType) || new Set()

    // 角色维度：按游戏、星级、名字排，附带 zset 人数
    const client = this.redis
    const charIds = [...charSet]
    const countPairs = await Promise.all(
      charIds.map(async (id) => {
        try {
          /* 同样必须走原始 key：拼 `miao:rank:<归一gid>:...` 对 group- 前缀的群恒为 0，
              会让 chars 被 .filter(count>0) 清空，整榜变成「没有可用的角色数据」。
              两种前缀都在时取人数多的那份。 */
          const cands = group.rawAll?.get(`${activeType}:${id}`)
          if (!cands?.length) {
            const n = await client.zCard(`miao:rank:${group.gid}:${activeType}:${id}`)
            return [id, Number(n) || 0]
          }
          if (cands.length === 1) return [id, Number(await client.zCard(cands[0])) || 0]
          const cs = await Promise.all(cands.map((k) => client.zCard(k).catch(() => 0)))
          return [id, Math.max(...cs.map(Number), 0)]
        } catch {
          return [id, 0]
        }
      }),
    )
    const countMap = new Map(countPairs)

    const chars = charIds
      .map((id) => {
        const m = meta.get(String(id)) || {}
        return {
          id: String(id),
          name: m.name || `#${id}`,
          abbr: m.abbr || '',
          game: m.game || '',
          star: m.star || 0,
          elem: m.elem || '',
          count: countMap.get(id) || 0,
        }
      })
      .filter((c) => c.count > 0)
      .sort((a, b) => {
        if (a.game !== b.game) return a.game === 'gs' ? -1 : 1
        if (b.star !== a.star) return b.star - a.star
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })

    if (!chars.length) return {available: true, empty: true, reason: '没有可用的角色数据', rows: [], chars: []}

    // 没指定角色就选参与人数最多的那个，避免打开页面看到空榜
    const activeChar = chars.find((c) => c.id === String(charId)) || [...chars].sort((a, b) => b.count - a.count)[0]
    const charOptions = chars

    const cap = Math.min(Math.max(Number(limit) || 20, 5), 100)
    /* 键必须用扫描时记下的原始 key：同一个群在 Redis 里可能同时存在
       `xxx@chatroom` 与 `group-xxx@chatroom` 两套键，而 gid 归一后重新拼接会拼出
       一个根本不存在的键（只有 group- 前缀的群会整榜查空）。
       两种前缀都在时取人数多的那份，避免只显示一半人。 */
    const pair = `${activeType}:${activeChar.id}`
    const rawCands = group.rawAll?.get(pair) || []
    let key = `miao:rank:${group.gid}:${activeType}:${activeChar.id}`
    if (rawCands.length === 1) {
      key = rawCands[0]
    } else if (rawCands.length > 1) {
      const counts = await Promise.all(rawCands.map((k) => client.zCard(k).catch(() => 0)))
      let best = 0
      for (let i = 1; i < counts.length; i++) if (Number(counts[i]) > Number(counts[best])) best = i
      key = rawCands[best] || rawCands[0]
    }

    let raw = []
    try {
      // redis 客户端 4.7.1 没有 zRevRangeWithScores，而 ZRANGE ... REV 又不被 Redis 5 支持，
      // 只能走原生命令：返回 [member, score, member, score, ...] 的扁平数组
      const flat = (await client.sendCommand(['ZREVRANGE', key, '0', String(cap - 1), 'WITHSCORES'])) || []
      for (let i = 0; i < flat.length; i += 2) {
        raw.push({ value: String(flat[i]), score: Number(flat[i + 1]) || 0 })
      }
    } catch {
      raw = []
    }

    const userMap = this.statsService.userNameMap()

    // uid → wxid/qq（miao 自己存的映射）
    const uids = raw.map((r) => String(r.value ?? r.member ?? ''))
    const infoPairs = await Promise.all(
      uids.map(async (uid) => {
        try {
          const s = await client.get(`miao:rank:uid-info:${uid}`)
          const o = s ? JSON.parse(s) : null
          return [uid, String(o?.qq ?? o?.wxid ?? '')]
        } catch {
          return [uid, '']
        }
      }),
    )
    const infoMap = new Map(infoPairs)

    const rows = raw.map((r, i) => {
      const uid = String(r.value ?? r.member ?? '')
      const score = Math.round(Number(r.score ?? 0) * 10) / 10
      const wxid = infoMap.get(uid) || ''
      return {
        rank: i + 1,
        uid,
        wxid,
        name: userMap.get(wxid) || '',
        score,
      }
    })

    // 均值/最高分（基于完整 zset 会多一次往返，这里用卡片数 + 头部均值说明量级）
    const total = Number((await client.zCard(key).catch(() => 0)) || 0)
    const shown = rows.length || 1
    const avg = rows.reduce((a, b) => a + b.score, 0) / shown
    const max = rows.length ? rows[0].score : 0

    return {
      available: true,
      empty: false,
      gid: group.gid,
      gidName: nameMap.get(group.gid) || nameMap.get(`group-${group.gid}`) || '',
      type: activeType,
      typeLabel: TYPE_LABEL[activeType] || activeType,
      types,
      char: activeChar,
      chars: charOptions,
      rows,
      summary: {
        total,
        shown: rows.length,
        avg: Math.round(avg * 10) / 10,
        max,
      },
    }
  }

  /* ------------------------------ 批量计数 ------------------------------ */

  /**
   * 批量 zCard，一次往返拿回上千个键的人数
   * 实测 4227 个键约 60ms，不需要分批
   * @param {string[]} keys
   * @returns {Promise<Map<string, number>>}
   */
  async _zCards(keys) {
    const out = new Map()
    const client = this.redis
    const list = (keys || []).filter(Boolean)
    if (!client || !list.length) return out

    let res = null
    try {
      const multi = client.multi()
      // 用 addCommand 而不是 multi.zCard()：偶尔有非 zset 键，typed 调用会让整个 exec 抛 MultiErrorReply
      for (const key of list) multi.addCommand(['ZCARD', key])
      res = typeof multi.execAsPipeline === 'function' ? await multi.execAsPipeline() : await multi.exec()
    } catch (e) {
      // exec() 遇到坏键会抛，逐条结果还在 replies 里
      res = e?.replies || null
    }

    if (Array.isArray(res) && res.length === list.length) {
      list.forEach((key, i) => out.set(key, Number(res[i]) || 0))
      return out
    }

    // 退化：逐条查（只在 multi 不可用时走到）
    await Promise.all(
      list.map(async (key) => {
        try {
          out.set(key, Number(await client.zCard(key)) || 0)
        } catch {
          out.set(key, 0)
        }
      }),
    )
    return out
  }

  /* ------------------------------ 汇总（overview / charUsage 共用） ------------------------------ */

  /**
   * 一次性把所有 zset 的人数算完，60 秒内复用（overview 与 charUsage 共用同一份）
   *
   * 口径：同一个群可能同时有 `gid` 与 `group-gid` 两种前缀，两者的 `type:charId` 大量重叠
   * 但人数并不相同（实测 43172716343 的 370/383 重叠，group- 那批人数更多）。
   * 直接相加会重复计数，所以每个 `type:charId` 只取人数最多的原始键。
   */
  async _agg(force = false) {
    const now = Date.now()
    if (!force && this._aggCache && now - this._aggCache.at < CACHE_TTL) return this._aggCache.data

    const {groups} = await this._scanRank(force)
    const meta = this._charMeta()

    const allKeys = []
    for (const g of groups.values()) for (const list of g.rawAll.values()) allKeys.push(...list)
    const cards = await this._zCards(allKeys)

    const byType = new Map() // type -> Map<charId, {groups: Set<gid>, count}>
    const typeGroups = new Map() // type -> Set<gid>
    const list = []

    for (const g of groups.values()) {
      const pairs = new Map() // 'type:charId' -> {key, count}
      const types = {}
      let members = 0
      let keyCount = 0
      let topChar = null

      for (const [pair, rawList] of g.rawAll) {
        const sep = pair.indexOf(':')
        const type = pair.slice(0, sep)
        const charId = pair.slice(sep + 1)
        keyCount += rawList.length

        // 两种前缀并存时取人数多的那个，避免同一批人被算两遍
        let best = {key: '', count: 0}
        for (const key of rawList) {
          const n = cards.get(key) || 0
          if (n > best.count) best = {key, count: n}
        }
        if (best.count <= 0) continue

        pairs.set(pair, best)
        members += best.count
        types[type] = (types[type] || 0) + 1

        if (!typeGroups.has(type)) typeGroups.set(type, new Set())
        typeGroups.get(type).add(g.gid)

        if (!byType.has(type)) byType.set(type, new Map())
        const charMap = byType.get(type)
        if (!charMap.has(charId)) charMap.set(charId, {groups: new Set(), count: 0})
        const entry = charMap.get(charId)
        entry.groups.add(g.gid)
        entry.count += best.count

        if (!topChar || best.count > topChar.count) {
          topChar = {id: charId, name: meta.get(charId)?.name || `#${charId}`, count: best.count}
        }
      }

      if (!members) continue

      const rawGids = [...g.rawGids.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([k]) => k)

      list.push({
        gid: displayGid(g.gid),
        rawGid: rawGids[0] || g.gid,
        rawGids,
        keys: keyCount,
        charCount: pairs.size,
        members,
        types,
        topChar,
        pairs,
      })
    }

    list.sort((a, b) => b.members - a.members)
    const data = {list, byType, typeGroups, charMeta: meta.size, at: now}
    this._aggCache = {at: now, data}
    return data
  }

  /* ------------------------------ 跨群总览 ------------------------------ */

  /** 每群体量一行，用于跨群横向对比 */
  async overview({force = false} = {}) {
    if (!this.available) return {available: false, types: [], groups: [], scannedAt: new Date().toISOString()}

    const agg = await this._agg(force)
    const nameMap = this.statsService.groupNameMap()

    const types = [...agg.typeGroups.entries()]
      .map(([key, set]) => ({key, label: TYPE_LABEL[key] || key, groups: set.size}))
      .sort((a, b) => b.groups - a.groups)

    const groups = agg.list.map((g) => ({
      gid: g.gid,
      name: nameMap.get(g.rawGid) || nameMap.get(`${g.gid}@chatroom`) || nameMap.get(g.gid) || '',
      rawGid: g.rawGid,
      rawGids: g.rawGids,
      boardGid: normGid(g.rawGid), // 传回 /board 用（那边要带 @chatroom）
      keys: g.keys, // 原始 zset 键数（两种前缀合计）
      charCount: g.charCount, // 去重后的 type:charId 数
      members: g.members,
      types: g.types,
      topChar: g.topChar,
    }))

    return {
      available: true,
      types,
      groups,
      charMeta: agg.charMeta,
      scannedAt: new Date(agg.at).toISOString(),
    }
  }

  /* ------------------------------ 角色使用率 ------------------------------ */

  /**
   * 角色使用率：哪些角色在各群最普及
   * @param {object} opts
   * @param {string} opts.type   dmg | mark
   * @param {string} opts.game   gs | sr，空则不过滤
   * @param {number} opts.limit  取前 N（默认 30，最多 100）
   * @param {boolean} opts.force 跳过缓存
   */
  async charUsage({type = 'dmg', game = '', limit = 30, force = false} = {}) {
    if (!this.available) return {available: false, type, typeLabel: TYPE_LABEL[type] || type, game: '', total: 0, chars: []}

    const agg = await this._agg(force)
    const meta = this._charMeta()
    const activeType = agg.byType.has(type) ? type : [...agg.typeGroups.keys()][0] || 'dmg'
    const charMap = agg.byType.get(activeType) || new Map()

    let chars = [...charMap.entries()].map(([id, e]) => {
      const m = meta.get(id) || {}
      const groups = e.groups.size
      return {
        id,
        name: m.name || `#${id}`,
        game: m.game || '',
        star: m.star || 0,
        elem: m.elem || '',
        groups,
        count: e.count,
        avg: Math.round((e.count / Math.max(groups, 1)) * 10) / 10,
      }
    })
    if (game) chars = chars.filter((c) => c.game === game)
    chars.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))

    const total = chars.length
    const cap = Math.min(Math.max(Number(limit) || 30, 1), 100)

    return {
      available: true,
      type: activeType,
      typeLabel: TYPE_LABEL[activeType] || activeType,
      game: game || '',
      total,
      chars: chars.slice(0, cap),
      scannedAt: new Date(agg.at).toISOString(),
    }
  }

  /* ------------------------------ 同角色跨群对比 ------------------------------ */

  /**
   * 同一个角色在不同群的表现（榜首 + 榜单人数）
   * @param {object} opts
   * @param {string} opts.type    dmg | mark
   * @param {string} opts.charId  空则自动选总人数最多的角色（复用 charUsage 的汇总）
   */
  async compareGroups({type = 'dmg', charId = ''} = {}) {
    if (!this.available) return {available: false, groups: [], char: null}

    const agg = await this._agg()
    const meta = this._charMeta()
    const client = this.redis
    const activeType = agg.byType.has(type) ? type : [...agg.typeGroups.keys()][0] || 'dmg'
    const charMap = agg.byType.get(activeType) || new Map()

    let id = String(charId || '')
    if (!id) {
      const top = [...charMap.entries()].sort((a, b) => b[1].count - a[1].count)[0]
      id = top ? top[0] : ''
    }
    const typeLabel = TYPE_LABEL[activeType] || activeType
    if (!id) return {available: true, empty: true, type: activeType, typeLabel, char: null, groups: [], scannedAt: new Date(agg.at).toISOString()}

    const m = meta.get(id) || {}
    const char = {id, name: m.name || `#${id}`, game: m.game || '', star: m.star || 0, elem: m.elem || ''}
    const nameMap = this.statsService.groupNameMap()
    const userMap = this.statsService.userNameMap()
    const pair = `${activeType}:${id}`

    const rows = []
    for (const g of agg.list) {
      const hit = g.pairs.get(pair)
      const row = {
        gid: g.gid,
        name: nameMap.get(g.rawGid) || nameMap.get(`${g.gid}@chatroom`) || nameMap.get(g.gid) || '',
        rawGid: g.rawGid,
        count: hit?.count || 0,
        top: null,
      }
      if (hit?.key && hit.count > 0) {
        try {
          // redis 4.7.1 没有 zRevRangeWithScores，Redis 5 又不支持 ZRANGE ... REV，只能走原生命令
          const flat = (await client.sendCommand(['ZREVRANGE', hit.key, '0', '0', 'WITHSCORES'])) || []
          if (flat.length >= 2) {
            row.top = {
              uid: String(flat[0]),
              wxid: '',
              name: '',
              score: Math.round((Number(flat[1]) || 0) * 10) / 10,
            }
          }
        } catch {
          row.top = null
        }
      }
      rows.push(row)
    }

    // 榜首 uid → wxid/qq → 昵称（跟 board() 一个写法）
    await Promise.all(
      rows
        .filter((r) => r.top)
        .map(async (r) => {
          try {
            const s = await client.get(`miao:rank:uid-info:${r.top.uid}`)
            const o = s ? JSON.parse(s) : null
            r.top.wxid = String(o?.qq ?? o?.wxid ?? '')
          } catch {
            r.top.wxid = ''
          }
          r.top.name = userMap.get(r.top.wxid) || ''
        }),
    )

    // 有榜首的按分数降序，没榜的（top=null）排最后
    rows.sort((a, b) => {
      if (!a.top && !b.top) return b.count - a.count
      if (!a.top) return 1
      if (!b.top) return -1
      return b.top.score - a.top.score
    })

    return {
      available: true,
      type: activeType,
      typeLabel,
      char,
      groups: rows,
      scannedAt: new Date(agg.at).toISOString(),
    }
  }
}
