import {autowired, Service} from '#guoba.framework'

/**
 * 插件数据管理服务（Redis 侧）
 *
 * 目标：让后台能对**所有插件**产生的数据做查看 / 编辑 / 删除，
 * 而不局限于米游社账号体系。
 *
 * 设计原则：
 *   1. 只做点操作（GET/SET/DEL/HSET…），不做 KEYS *、不做 FLUSHDB
 *   2. 命名空间（前缀）有归属映射，标明插件、用途与风险等级
 *   3. 删除 / 覆盖前先把旧值 dump 到 admin.db 的 redis_backup 表，可回滚
 *   4. 每次写操作落 audit_log
 *   5. 单值大小上限，超限只读不可编辑
 */

/** 游戏分类（一级目录）：id 与 GameIcon / MysUsers.uids 的 key 对齐 */
const GAMES = [
  {id: 'gs', name: '原神'},
  {id: 'sr', name: '星穹铁道'},
  {id: 'zzz', name: '绝区零'},
  {id: 'waves', name: '鸣潮'},
  {id: 'bh3', name: '崩坏3'},
  {id: 'bh2', name: '崩坏学园2'},
  {id: 'wd', name: '未定事件簿'},
  {id: 'ark', name: '明日方舟'},
  {id: 'ai', name: 'AI 助手'},
  {id: 'common', name: '通用 / 系统'},
  {id: 'unknown', name: '未收录'},
]

/** 命名空间 → 插件归属与风险等级（game = 一级目录：游戏归属） */
const DOMAINS = [
  {prefix: 'Yz:count', game: 'common', plugin: '云崽核心', label: '消息计数', risk: 'high', desc: '按天记录的用户/群收发消息量，是所有活跃统计的基础'},
  {prefix: 'Yz:cache', game: 'common', plugin: '云崽核心', label: '米游社缓存', risk: 'low', desc: '米游社接口查询结果缓存（原神/星铁/绝区零共用），删除后下次查询会重新拉取'},
  {prefix: 'Yz:group_id', game: 'common', plugin: '云崽核心', label: '用户群映射', risk: 'mid', desc: '用户与群的关联关系，删除会影响群内定向推送'},
  {prefix: 'Yz:GMx', game: 'common', plugin: '群管增强', label: '群日总计', risk: 'mid', desc: '群消息日汇总，用于活跃统计'},
  {prefix: 'Yz:GM', game: 'common', plugin: '群管增强', label: '活跃榜', risk: 'mid', desc: '群活跃榜 zset 与群主/群管名单'},
  {prefix: 'Yz:Lotus', game: 'common', plugin: '荷花签到', label: '签到配置', risk: 'mid', desc: '签到插件的运行时配置与状态（覆盖全部游戏）'},
  {prefix: 'Yz:wavesJs', game: 'waves', plugin: 'Cloudtide Waves', label: '鸣潮插件数据', risk: 'mid', desc: '鸣潮面板与查询缓存'},
  {prefix: 'Yunzai:waves', game: 'waves', plugin: 'Cloudtide Waves', label: '鸣潮数据', risk: 'mid', desc: '鸣潮账号与 UID 绑定'},
  {prefix: 'miao:rank', game: 'gs', plugin: 'miao-plugin', label: '角色排行', risk: 'low', desc: '角色伤害排行（含群榜），可安全清理重建'},
  {prefix: 'miao:profile', game: 'gs', plugin: 'miao-plugin', label: '玩家档案', risk: 'mid', desc: '米游社玩家信息快照（原神为主，含星铁），删除后需重新查询'},
  {prefix: 'miao:user-cfg', game: 'gs', plugin: 'miao-plugin', label: '用户偏好', risk: 'mid', desc: '用户级面板与查询偏好'},
  {prefix: 'CHATGPT:MESSAGE', game: 'ai', plugin: 'ChatGPT', label: 'AI 会话上下文', risk: 'mid', desc: '大模型对话上下文，删除等于清空记忆'},
  {prefix: 'CHATGPT:CONVERSATIONS', game: 'ai', plugin: 'ChatGPT', label: 'AI 会话索引', risk: 'mid', desc: '会话列表与配置索引'},
  {prefix: 'ark-plugin:stygianInfo', game: 'ark', plugin: 'ark-plugin', label: '生息演算数据', risk: 'low', desc: '明日方舟生息演算信息'},
  {prefix: 'ark-plugin:stygianRank', game: 'ark', plugin: 'ark-plugin', label: '生息演算排行', risk: 'low', desc: '明日方舟生息演算排行榜'},
  {prefix: 'xiaoyao:basic', game: 'gs', plugin: 'xiaoyao-cvs', label: '基础配置', risk: 'mid', desc: 'xiaoyao-cvs 插件（原神面板图）的基础配置与绑定'},
  {prefix: 'ZZZ:PANEL', game: 'zzz', plugin: 'ZZZ-Plugin', label: '绝区零面板', risk: 'low', desc: '绝区零角色面板缓存'},
  {prefix: 'ZZZ:GACHA', game: 'zzz', plugin: 'ZZZ-Plugin', label: '绝区零抽卡', risk: 'low', desc: '绝区零抽卡记录缓存'},
  {prefix: 'ZZZ:DEVICE_FP', game: 'zzz', plugin: 'ZZZ-Plugin', label: '设备指纹', risk: 'mid', desc: '米游社接口设备指纹'},
  {prefix: 'yenai:mergeCfg', game: 'common', plugin: 'yenai-plugin', label: '合并配置', risk: 'mid', desc: 'yenai 插件的合并转发配置'},
  {prefix: 'MysAPI', game: 'common', plugin: 'MysAPI 层', label: '接口态数据', risk: 'mid', desc: 'Cookie / 设备指纹等接口层数据'},
  {prefix: 'STAR_RAILWAY', game: 'sr', plugin: 'StarRail', label: '星铁数据', risk: 'low', desc: '星穹铁道抽卡与 UID 记录'},
  {prefix: 'Yz:GamePush', game: 'common', plugin: '云崽核心', label: '游戏推送', risk: 'mid', desc: '游戏推送订阅状态'},
  {prefix: 'Yz:liulian', game: 'common', plugin: '云崽核心', label: '留联数据', risk: 'low', desc: '留联插件的会话数据'},
  {prefix: 'Yunzai:logier', game: 'common', plugin: 'logier-plugin', label: '日志数据', risk: 'low', desc: '日志插件的索引'},
  {prefix: 'zhishui', game: 'common', plugin: 'yijing-game', label: '游戏数据', risk: 'low', desc: '文字游戏插件的检索数据'},
  {prefix: 'deepseek', game: 'ai', plugin: 'DeepSeek', label: 'AI 群配置', risk: 'mid', desc: 'DeepSeek 插件的群级配置'},
  {prefix: 'deepseekJS', game: 'ai', plugin: 'DeepSeek', label: 'AI 状态', risk: 'low', desc: 'DeepSeek 插件的运行时状态'},
]

const MAX_VALUE_BYTES = 256 * 1024
const MAX_SCAN_KEYS = 4000

export class DataService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    this._domainsCache = null
  }

  _redis() {
    const r = globalThis.redis
    if (!r) {
      throw new Error('Redis 未就绪，请确认 Bot 已正常启动')
    }
    return r
  }

  // ------------------------------------------------------------ 数据域

  /** 归属某个前缀的插件信息；未收录的前缀给通用描述 */
  _domainOf(key) {
    let best = null
    for (const d of DOMAINS) {
      if (key === d.prefix || key.startsWith(`${d.prefix}:`)) {
        if (!best || d.prefix.length > best.prefix.length) {
          best = d
        }
      }
    }
    return best
  }

  /**
   * 数据域总览：一次全量 SCAN 按「最长前缀」归组，结果缓存 5 分钟
   * 避免为每个前缀单独扫一遍
   */
  async getDomains(force = false) {
    const now = Date.now()
    if (!force && this._domainsCache && now - this._domainsCache.at < 300_000) {
      return this._domainsCache.data
    }
    const redis = this._redis()

    const counts = new Map()
    const samples = new Map()
    let total = 0
    let cursor = '0'
    let guard = 0
    do {
      const r = await redis.scan(cursor, {COUNT: 4000})
      cursor = String(r.cursor)
      for (const key of r.keys) {
        total += 1
        const d = this._domainOf(key)
        const id = d ? d.prefix : '（未收录）'
        counts.set(id, (counts.get(id) || 0) + 1)
        const arr = samples.get(id) || []
        if (arr.length < 3) {
          arr.push(key)
          samples.set(id, arr)
        }
      }
      if (++guard > 60) {
        break
      }
    } while (cursor !== '0')

    const groups = new Map()
    for (const d of DOMAINS) {
      const count = counts.get(d.prefix) || 0
      if (count === 0) {
        continue
      }
      const g = groups.get(d.plugin) || {plugin: d.plugin, count: 0, domains: []}
      g.count += count
      g.domains.push({...d, count, samples: samples.get(d.prefix) || []})
      groups.set(d.plugin, g)
    }

    const unknownCount = counts.get('（未收录）') || 0
    /** 扁平列表：带上各自键数，前端左侧命名空间直接消费（含 0 键的域，排在末尾） */
    const flat = DOMAINS.map((d) => ({
      ...d,
      count: counts.get(d.prefix) || 0,
      samples: samples.get(d.prefix) || [],
    })).sort((a, b) => b.count - a.count)

    /** 一级目录：按游戏分组（键数 > 0 的游戏排前面，其余按 GAMES 定义的固定顺序） */
    const gameMap = new Map()
    for (const g of GAMES) {
      gameMap.set(g.id, {id: g.id, name: g.name, count: 0, domainCount: 0, domains: []})
    }
    for (const d of flat) {
      const g = gameMap.get(d.game) || gameMap.get('unknown')
      g.count += d.count
      g.domains.push(d)
      g.domainCount += 1
    }
    const unknownGroup = gameMap.get('unknown')
    unknownGroup.count = unknownCount
    unknownGroup.domainCount = unknownCount > 0 ? 1 : 0
    unknownGroup.samples = samples.get('（未收录）') || []
    const games = [...gameMap.values()].sort((a, b) => {
      if ((b.count > 0) !== (a.count > 0)) return (b.count > 0) ? 1 : -1
      if (b.count !== a.count) return b.count - a.count
      return GAMES.findIndex((g) => g.id === a.id) - GAMES.findIndex((g) => g.id === b.id)
    })

    const data = {
      available: true,
      totalKeys: total,
      unknownCount,
      unknownSamples: samples.get('（未收录）') || [],
      games,
      plugins: [...groups.values()].sort((a, b) => b.count - a.count),
      domains: flat,
      scannedAt: new Date().toISOString(),
    }
    this._domainsCache = {at: now, data}
    return data
  }

  /** 某个前缀下的键列表（SCAN MATCH，限制最大收集数） */
  async listKeys({prefix = '', q = '', page = 1, size = 20} = {}) {
    const redis = this._redis()
    const match = prefix ? `${prefix}*` : (q ? `*${q}*` : '*')
    const collected = []
    let cursor = '0'
    let guard = 0
    do {
      const r = await redis.scan(cursor, {MATCH: match, COUNT: 1000})
      cursor = String(r.cursor)
      for (const k of r.keys) {
        if (q && !k.toLowerCase().includes(String(q).toLowerCase())) {
          continue
        }
        collected.push(k)
      }
      if (++guard > 60 || collected.length >= MAX_SCAN_KEYS) {
        break
      }
    } while (cursor !== '0')

    collected.sort()
    const total = collected.length
    const p = Math.max(1, Number(page) || 1)
    const s = Math.min(200, Math.max(5, Number(size) || 20))
    const pageKeys = collected.slice((p - 1) * s, (p - 1) * s + s)

    const list = []
    for (const key of pageKeys) {
      const [type, ttl] = await Promise.all([redis.type(key), redis.ttl(key)])
      list.push({
        key,
        type,
        ttl: typeof ttl === 'number' ? ttl : -1,
        domain: this._domainOf(key) || null,
      })
    }
    return {total, page: p, size: s, truncated: total >= MAX_SCAN_KEYS, list}
  }

  /** 读取单个键的完整值（按类型解码） */
  async getKey(key) {
    const redis = this._redis()
    if (!key) {
      throw new Error('key 不能为空')
    }
    const type = await redis.type(key)
    if (type === 'none') {
      throw new Error('键不存在')
    }
    const ttl = await redis.ttl(key)
    let value = null
    let size = 0

    if (type === 'string') {
      const raw = await redis.get(key)
      size = Buffer.byteLength(raw || '', 'utf8')
      value = raw
    } else if (type === 'hash') {
      const obj = await redis.hGetAll(key)
      value = obj
      size = Buffer.byteLength(JSON.stringify(obj), 'utf8')
    } else if (type === 'list') {
      const arr = await redis.lRange(key, 0, 499)
      value = arr
      size = Buffer.byteLength(JSON.stringify(arr), 'utf8')
    } else if (type === 'set') {
      const arr = await redis.sMembers(key)
      value = arr
      size = Buffer.byteLength(JSON.stringify(arr), 'utf8')
    } else if (type === 'zset') {
      const arr = await redis.zRangeWithScores(key, 0, 499)
      value = arr.map((x) => ({member: x.value, score: x.score}))
      size = Buffer.byteLength(JSON.stringify(value), 'utf8')
    } else {
      value = `（不支持编辑的类型：${type}）`
    }

    const domain = this._domainOf(key)
    return {
      key,
      type,
      ttl,
      size,
      value,
      editable: size <= MAX_VALUE_BYTES && ['string', 'hash', 'zset', 'set', 'list'].includes(type),
      risk: domain?.risk || 'unknown',
      domain,
    }
  }

  /** 备份旧值到 admin.db，返回备份 id */
  _backup(key, type, value, action, ctx) {
    const db = this.dbService.getAdminDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS redis_backup (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL,
        type       TEXT,
        value      TEXT,
        action     TEXT,
        actor      TEXT,
        created_at TEXT
      );
    `)
    const info = db
      .prepare('INSERT INTO redis_backup (key, type, value, action, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, type, JSON.stringify(value), action, ctx?.actor || '', new Date().toISOString())
    return info.lastInsertRowid
  }

  /** 写入键值（会先备份旧值） */
  async setKey(key, payload, ctx = {}) {
    const redis = this._redis()
    if (!key) {
      throw new Error('key 不能为空')
    }
    const oldType = await redis.type(key)
    let oldValue = null
    if (oldType !== 'none') {
      try {
        oldValue = (await this.getKey(key)).value
      } catch {}
      this._backup(key, oldType, oldValue, 'overwrite', ctx)
    }

    const type = payload?.type || oldType || 'string'
    const value = payload?.value

    if (type === 'string') {
      if (typeof value !== 'string') {
        throw new Error('string 类型的值必须是字符串')
      }
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        throw new Error('值超过 256KB，拒绝写入')
      }
      await redis.set(key, value)
    } else if (type === 'hash') {
      const obj = typeof value === 'string' ? JSON.parse(value) : value
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('hash 需要提供 JSON 对象')
      }
      await redis.del(key)
      const entries = Object.entries(obj)
      if (entries.length) {
        await redis.hSet(key, Object.fromEntries(entries.map(([k, v]) => [k, String(v)])))
      }
    } else if (type === 'zset') {
      const arr = typeof value === 'string' ? JSON.parse(value) : value
      if (!Array.isArray(arr)) {
        throw new Error('zset 需要提供 [{member,score}] 数组')
      }
      await redis.del(key)
      if (arr.length) {
        await redis.zAdd(key, arr.map((x) => ({score: Number(x.score) || 0, value: String(x.member)})))
      }
    } else if (type === 'set') {
      const arr = typeof value === 'string' ? JSON.parse(value) : value
      if (!Array.isArray(arr)) {
        throw new Error('set 需要提供数组')
      }
      await redis.del(key)
      if (arr.length) {
        await redis.sAdd(key, arr.map(String))
      }
    } else if (type === 'list') {
      const arr = typeof value === 'string' ? JSON.parse(value) : value
      if (!Array.isArray(arr)) {
        throw new Error('list 需要提供数组')
      }
      await redis.del(key)
      if (arr.length) {
        await redis.rPush(key, arr.map(String))
      }
    } else {
      throw new Error(`不支持写入类型：${type}`)
    }

    if (payload?.ttl != null && Number(payload.ttl) > 0) {
      await redis.expire(key, Number(payload.ttl))
    }

    this.dbService.writeAudit({
      ...ctx,
      action: 'redis.set',
      target: key,
      detail: {type, size: Buffer.byteLength(JSON.stringify(value), 'utf8')},
    })
    return {key, type}
  }

  /** 删除键（先备份） */
  async deleteKey(key, ctx = {}) {
    const redis = this._redis()
    if (!key) {
      throw new Error('key 不能为空')
    }
    const type = await redis.type(key)
    if (type === 'none') {
      throw new Error('键不存在')
    }
    let value = null
    try {
      value = (await this.getKey(key)).value
    } catch {}
    const backupId = this._backup(key, type, value, 'delete', ctx)
    await redis.del(key)
    this.dbService.writeAudit({...ctx, action: 'redis.delete', target: key, detail: {type, backupId}})
    return {key, backupId}
  }

  /** 按前缀批量删除（需二次确认，逐个备份） */
  async deleteByPrefix(prefix, ctx = {}) {
    if (!prefix || prefix.length < 4) {
      throw new Error('前缀太短，拒绝批量删除')
    }
    const redis = this._redis()
    const keys = []
    let cursor = '0'
    let guard = 0
    do {
      const r = await redis.scan(cursor, {MATCH: `${prefix}*`, COUNT: 1000})
      cursor = String(r.cursor)
      keys.push(...r.keys)
      if (++guard > 40 || keys.length > 2000) {
        break
      }
    } while (cursor !== '0')

    if (keys.length === 0) {
      return {deleted: 0, prefix}
    }
    if (keys.length > 2000) {
      throw new Error(`匹配到 ${keys.length} 个键，超过单次上限（2000），请缩小前缀`)
    }

    let deleted = 0
    const failed = []
    for (const key of keys) {
      try {
        const type = await redis.type(key)
        let value = null
        try {
          value = (await this.getKey(key)).value
        } catch {}
        this._backup(key, type, value, 'batch-delete', ctx)
        await redis.del(key)
        deleted += 1
      } catch (e) {
        failed.push({key, error: e.message})
      }
    }
    this.dbService.writeAudit({...ctx, action: 'redis.deletePrefix', target: prefix, detail: {deleted, failed: failed.length}})
    return {deleted, failed, prefix}
  }

  /** 设置 TTL（秒，-1 表示永久） */
  async setTtl(key, seconds, ctx = {}) {
    const redis = this._redis()
    const s = Number(seconds)
    if (s === -1) {
      await redis.persist(key)
    } else if (s > 0) {
      await redis.expire(key, s)
    } else {
      throw new Error('TTL 必须为正数或 -1')
    }
    this.dbService.writeAudit({...ctx, action: 'redis.ttl', target: key, detail: {ttl: s}})
    return {key, ttl: s}
  }

  /** 备份列表 */
  listBackups(limit = 100) {
    const db = this.dbService.getAdminDb()
    db.exec(`CREATE TABLE IF NOT EXISTS redis_backup (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, type TEXT, value TEXT,
      action TEXT, actor TEXT, created_at TEXT
    );`)
    return db
      .prepare('SELECT id, key, type, action, actor, created_at FROM redis_backup ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Number(limit) || 100))
  }

  /** 从备份恢复 */
  async restoreBackup(id, ctx = {}) {
    const db = this.dbService.getAdminDb()
    const row = db.prepare('SELECT * FROM redis_backup WHERE id = ?').get(Number(id))
    if (!row) {
      throw new Error('备份不存在')
    }
    let value
    try {
      value = JSON.parse(row.value)
    } catch {
      throw new Error('备份内容损坏')
    }
    await this.setKey(row.key, {type: row.type, value}, {...ctx, action: 'redis.restore'})
    this.dbService.writeAudit({...ctx, action: 'redis.restore', target: row.key, detail: {backupId: id}})
    return {key: row.key, restored: true}
  }
}
