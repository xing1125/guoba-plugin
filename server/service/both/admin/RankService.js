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

export class RankService extends Service {

  statsService = autowired('statsService')

  constructor(app) {
    super(app)
    const pluginsRoot = path.dirname(_paths.pluginRoot || path.join(_paths.data, '..', 'plugins'))
    this.miaoRoot = path.join(pluginsRoot, 'miao-plugin', 'resources')
    this._chars = null
    this._scanCache = null
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

    // gid -> {gid, chars: Map<type, Set<charId>>}
    const groups = new Map()
    for (const key of keys) {
      const m = RANK_KEY_RE.exec(key)
      if (!m) continue
      const gid = normGid(m[1])
      const type = m[2]
      const charId = m[3]
      if (!gid) continue
      let g = groups.get(gid)
      if (!g) {
        g = {gid, chars: new Map()}
        groups.set(gid, g)
      }
      if (!g.chars.has(type)) g.chars.set(type, new Set())
      g.chars.get(type).add(charId)
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
    const group = groups.get(normed)
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
          const n = await client.zCard(`miao:rank:${group.gid}:${activeType}:${id}`)
          return [id, Number(n) || 0]
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
    const key = `miao:rank:${group.gid}:${activeType}:${activeChar.id}`

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
}
