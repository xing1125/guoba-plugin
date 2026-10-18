import crypto from 'crypto'
import {autowired, Service} from '#guoba.framework'

const GAME_KEYS = ['gs', 'sr', 'zzz', 'bh3', 'bh2', 'wd']

/**
 * 鸣潮（库街区）UID 存储键：与 Cloudtide Waves-plugin 的 model/user.js 保持一致。
 * 鸣潮不在米游社体系内，其 UID 走库街区 token 绑定，存在独立 Redis 键里，
 * 与 MysUsers.ltuid 体系无归属关系，故在「游戏 UID」页单独聚合展示。
 */
const WAVES_USERS_KEY = 'Yz:wavesJs:users'
const WAVES_USER_KEY = (qq) => `Yz:wavesJs:user:${qq}`

/** 米游社 CN 客户端请求头（与 miao 插件保持一致） */
const CN_CLIENT = {
  app_version: '2.73.1',
  client_type: '5',
  userAgent:
    'Mozilla/5.0 (Linux; Android 12; XQ-AT52 Build/58.2.A.7.93; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.88 Mobile Safari/537.36 miHoYoBBS/2.73.1',
  origin: 'https://webstatic.mihoyo.com',
}
const DS_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 取 CK 脱敏串：只暴露 ltoken 前 8 位与后 4 位，其余 cookie 一律不显示 */
function maskCk(ck) {
  const s = String(ck || '')
  if (!s) return ''
  const matched = /ltoken=([^;]+)/.exec(s)
  const token = matched ? matched[1] : s
  if (token.length <= 12) return 'ltoken=****'
  return `ltoken=${token.slice(0, 8)}****${token.slice(-4)}`
}

function parseUids(json) {
  try {
    const obj = JSON.parse(json || '{}')
    const ret = {}
    for (const key of GAME_KEYS) {
      const arr = obj[key]
      ret[key] = Array.isArray(arr) ? arr.filter(Boolean).map(String) : []
    }
    return ret
  } catch {
    return GAME_KEYS.reduce((acc, k) => ({...acc, [k]: []}), {})
  }
}

function signDs(query) {
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const ds = md5(`salt=${DS_SALT}&t=${t}&r=${r}&b=&q=${query}`)
  return `${t},${r},${ds}`
}

export class AdminService extends Service {

  dbService = autowired('dbService')

  statsService = autowired('statsService')

  constructor(app) {
    super(app)
  }

  get db() {
    return this.dbService
  }

  // ---------------------------------------------------------------- 查询

  /** 读取 ltuid -> [绑定用户标识] 映射 */
  _bindMap() {
    const bot = this.db.getBotDb()
    if (!bot) return new Map()
    const map = new Map()
    try {
      const rows = bot.prepare('SELECT id, ltuids FROM Users').all()
      for (const row of rows) {
        if (!row.ltuids) continue
        for (const ltuid of String(row.ltuids).split(',')) {
          const key = Number(ltuid.trim())
          if (!key) continue
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(String(row.id))
        }
      }
    } catch (e) {
      logger.error(`[admin] 读取绑定关系失败：${e.message}`)
    }
    return map
  }

  /** uid（wxid）-> 昵称：来自 StatsService 的运行时内存 + admin.db 快照 */
  _nameMap() {
    try {
      const map = this.statsService?.getUserNameMap?.()
      return map instanceof Map ? map : new Map()
    } catch {
      return new Map()
    }
  }

  /** 解析筛选条件，返回 ltuid 候选集合；null 表示不限制 */
  _candidateLtuids(bot, {q, ckStatus}) {
    let candidates = null

    if (q) {
      const set = new Set()
      if (/^\d+$/.test(q)) {
        const rows = bot.prepare('SELECT ltuid FROM MysUsers WHERE CAST(ltuid AS TEXT) LIKE ?').all(`%${q}%`)
        rows.forEach((r) => set.add(Number(r.ltuid)))
      }
      const users = bot.prepare('SELECT ltuids FROM Users WHERE id LIKE ? LIMIT 200').all(`%${q}%`)
      for (const row of users) {
        if (!row.ltuids) continue
        for (const ltuid of String(row.ltuids).split(',')) {
          const key = Number(ltuid.trim())
          if (key) set.add(key)
        }
      }
      candidates = set
    }

    if (ckStatus) {
      const admin = this.db.getAdminDb()
      const rows = admin.prepare('SELECT ltuid FROM account_status WHERE ck_status = ?').all(ckStatus)
      const statusSet = new Set(rows.map((r) => Number(r.ltuid)))
      if (statusSet.size === 0) {
        // 该状态下没有记录，返回空集合而不是全量
        return new Set()
      }
      candidates = candidates ? new Set([...candidates].filter((x) => statusSet.has(x))) : statusSet
    }

    return candidates
  }

  /** 账号分页 */
  queryAccounts({page = 1, size = 20, q = '', ckStatus = '', game = ''} = {}) {
    const bot = this.db.getBotDb()
    const empty = {total: 0, page, size, list: []}
    if (!bot) return empty

    page = Math.max(1, Number(page) || 1)
    size = Math.min(100, Math.max(1, Number(size) || 20))

    const candidates = this._candidateLtuids(bot, {q, ckStatus})
    if (candidates && candidates.size === 0) return empty

    let where = []
    const args = []
    if (candidates) {
      const ids = [...candidates]
      // 数据量小（几十个账号），直接展开 IN 列表
      where.push(`ltuid IN (${ids.map(() => '?').join(',')})`)
      args.push(...ids)
    }
    if (game) {
      // 必须判断数组非空，否则 uids 里存在该游戏的空数组也会被命中
      where.push(`json_array_length(json_extract(uids, '$.' || ?)) > 0`)
      args.push(game)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const total = bot.prepare(`SELECT COUNT(*) AS n FROM MysUsers ${whereSql}`).get(...args).n
    const rows = bot
      .prepare(`SELECT ltuid, type, ck, uids, device_fp, updatedAt FROM MysUsers ${whereSql} ORDER BY ltuid LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size)

    const bindMap = this._bindMap()
    const nameMap = this._nameMap()
    const statusMap = this._statusMap(rows.map((r) => Number(r.ltuid)))

    const list = rows.map((row) => {
      const ltuid = Number(row.ltuid)
      const st = statusMap.get(ltuid)
      const bindIds = bindMap.get(ltuid) || []
      return {
        ltuid,
        accountType: row.type,
        ckMask: maskCk(row.ck),
        ckLen: row.ck ? String(row.ck).length : 0,
        hasDeviceFp: !!row.device_fp,
        uids: parseUids(row.uids),
        bindIds,
        bindNames: bindIds.map((id) => nameMap.get(id) || ''),
        ckStatus: st?.ck_status || 'unknown',
        checkedAt: st?.checked_at || null,
        updatedAt: row.updatedAt || null,
      }
    })

    return {total, page, size, list}
  }

  /** 单账号详情 */
  getAccount(ltuid) {
    const bot = this.db.getBotDb()
    if (!bot) return null
    const row = bot
      .prepare('SELECT ltuid, type, ck, uids, device_fp, updatedAt FROM MysUsers WHERE ltuid = ?')
      .get(Number(ltuid))
    if (!row) return null
    const key = Number(row.ltuid)
    const st = this._statusMap([key]).get(key)
    return {
      ltuid: key,
      accountType: row.type,
      ckMask: maskCk(row.ck),
      ckLen: row.ck ? String(row.ck).length : 0,
      hasDeviceFp: !!row.device_fp,
      uids: parseUids(row.uids),
      bindIds: this._bindMap().get(key) || [],
      ckStatus: st?.ck_status || 'unknown',
      checkedAt: st?.checked_at || null,
      updatedAt: row.updatedAt || null,
    }
  }

  _statusMap(ltuids) {
    const map = new Map()
    if (!ltuids.length) return map
    try {
      const admin = this.db.getAdminDb()
      const holes = ltuids.map(() => '?').join(',')
      const rows = admin
        .prepare(`SELECT ltuid, ck_status, checked_at FROM account_status WHERE ltuid IN (${holes})`)
        .all(...ltuids)
      rows.forEach((r) => map.set(Number(r.ltuid), r))
    } catch (e) {
      logger.error(`[admin] 读取校验状态失败：${e.message}`)
    }
    return map
  }

  /** 只读访问 Yunzai 全局 redis（与 StatsService 保持一致，降级为空） */
  get _redis() {
    return globalThis.redis ?? null
  }

  /** 兼容 node-redis v4（sMembers）/ v3（smembers） */
  async _redisSMembers(key) {
    const c = this._redis
    if (!c) return []
    try {
      if (typeof c.sMembers === 'function') return await c.sMembers(key)
      if (typeof c.smembers === 'function') return await c.smembers(key)
    } catch {}
    return []
  }

  async _redisGet(key) {
    const c = this._redis
    if (!c) return null
    try {
      return await c.get(key)
    } catch {}
    return null
  }

  /**
   * 鸣潮 UID 分页：遍历 Yz:wavesJs:users 集合，拉取每人的账号列表。
   * - uid      ：库街区特征码
   * - game     ：固定 'waves'
   * - ltuid    ：null（鸣潮不归属米游社账号，页内「归属账号」列留空）
   * - bindIds  ：绑定的 QQ / wxid（与米游社系 UIDs 的展示口径对齐）
   */
  async _queryWavesUids({page = 1, size = 20, q = ''} = {}) {
    page = Math.max(1, Number(page) || 1)
    size = Math.min(100, Math.max(1, Number(size) || 20))
    const ql = String(q || '').trim().toLowerCase()
    try {
      const qqs = await this._redisSMembers(WAVES_USERS_KEY)
      const nameMap = this._nameMap()
      const rows = []
      for (const qq of qqs) {
        const raw = await this._redisGet(WAVES_USER_KEY(qq))
        if (!raw) continue
        let data
        try {
          data = JSON.parse(raw)
        } catch {
          continue
        }
        const accounts = Array.isArray(data?.accounts) ? data.accounts : []
        for (const acc of accounts) {
          const uid = String(acc?.uid || '').trim()
          if (!uid) continue
          if (ql && !uid.toLowerCase().includes(ql)) continue
          const id = String(qq)
          rows.push({
            uid,
            game: 'waves',
            ltuid: null,
            bindIds: [id],
            bindNames: [nameMap.get(id) || ''],
          })
        }
      }
      rows.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
      const total = rows.length
      const start = (page - 1) * size
      return {total, page, size, list: rows.slice(start, start + size)}
    } catch (e) {
      logger.error(`[admin] 查询鸣潮 UID 失败：${e.message}`)
      return {total: 0, page, size, list: []}
    }
  }

  /** UID 分页（直接从 MysUsers.uids 展开，保证与 Bot 数据实时一致） */
  queryUids({game = 'gs', page = 1, size = 20, q = ''} = {}) {
    // 鸣潮走库街区体系，独立于 MysUsers，单独聚合
    if (game === 'waves') {
      return this._queryWavesUids({page, size, q})
    }

    const bot = this.db.getBotDb()
    const empty = {total: 0, page, size, list: []}
    if (!bot) return empty

    page = Math.max(1, Number(page) || 1)
    size = Math.min(100, Math.max(1, Number(size) || 20))

    const base = `
      SELECT m.ltuid AS ltuid, g.key AS game, u.value AS uid
      FROM MysUsers m, json_each(m.uids) g, json_each(g.value) u
      WHERE g.key <> '_meta' AND json_type(g.value) = 'array'
    `
    const where = ['t.game = ?']
    const args = [game]
    if (q) {
      where.push('(t.uid LIKE ? OR CAST(t.ltuid AS TEXT) LIKE ?)')
      args.push(`%${q}%`, `%${q}%`)
    }
    const whereSql = `WHERE ${where.join(' AND ')}`

    try {
      const total = bot.prepare(`SELECT COUNT(*) AS n FROM (${base}) t ${whereSql}`).get(...args).n
      const rows = bot
        .prepare(`SELECT * FROM (${base}) t ${whereSql} ORDER BY t.ltuid, t.uid LIMIT ? OFFSET ?`)
        .all(...args, size, (page - 1) * size)

      const bindMap = this._bindMap()
      const nameMap = this._nameMap()
      const list = rows.map((r) => {
        const bindIds = bindMap.get(Number(r.ltuid)) || []
        return {
          uid: String(r.uid),
          game: r.game,
          ltuid: Number(r.ltuid),
          bindIds,
          bindNames: bindIds.map((id) => nameMap.get(id) || ''),
        }
      })
      return {total, page, size, list}
    } catch (e) {
      logger.error(`[admin] 查询 UID 失败：${e.message}`)
      return empty
    }
  }

  /** 概览统计 */
  async getOverview() {
    const bot = this.db.getBotDb()
    const result = {
      accounts: {total: 0, ckOk: 0, expired: 0, unknown: 0, lastCheck: null},
      uids: {total: 0, byGame: {}},
      users: {total: 0, bound: 0},
      groups: {total: global.Bot?.gl?.size || 0, active7d: 0},
      message: {todaySend: 0, todayRecv: 0},
    }
    if (!bot) return result

    try {
      result.accounts.total = bot.prepare('SELECT COUNT(*) AS n FROM MysUsers').get().n
      result.users.total = bot.prepare('SELECT COUNT(*) AS n FROM Users').get().n
      result.users.bound = bot.prepare("SELECT COUNT(*) AS n FROM Users WHERE ltuids IS NOT NULL AND ltuids <> ''").get().n

      // UID 总数与分布
      const uidRows = bot
        .prepare(
          `SELECT g.key AS game, COUNT(*) AS n
           FROM MysUsers m, json_each(m.uids) g, json_each(g.value) u
           WHERE g.key <> '_meta' AND json_type(g.value) = 'array'
           GROUP BY g.key`,
        )
        .all()
      for (const row of uidRows) {
        result.uids.byGame[row.game] = row.n
        result.uids.total += row.n
      }

      // 鸣潮 UID（库街区体系，不在 MysUsers，单独聚合）
      try {
        const wq = await this._redisSMembers(WAVES_USERS_KEY)
        let wn = 0
        for (const qq of wq) {
          const raw = await this._redisGet(WAVES_USER_KEY(qq))
          if (!raw) continue
          try {
            const d = JSON.parse(raw)
            if (Array.isArray(d?.accounts)) {
              wn += d.accounts.filter((a) => String(a?.uid || '').trim()).length
            }
          } catch {}
        }
        if (wn) {
          result.uids.byGame.waves = wn
          result.uids.total += wn
        }
      } catch {}

      // CK 状态分布
      const admin = this.db.getAdminDb()
      const stat = admin
        .prepare(
          `SELECT ck_status, COUNT(*) AS n FROM account_status GROUP BY ck_status`,
        )
        .all()
      for (const row of stat) {
        if (row.ck_status === 'ok') result.accounts.ckOk = row.n
        if (row.ck_status === 'expired') result.accounts.expired = row.n
      }
      result.accounts.unknown = Math.max(
        0,
        result.accounts.total - result.accounts.ckOk - result.accounts.expired,
      )
      result.accounts.lastCheck =
        admin.prepare('SELECT MAX(checked_at) AS t FROM account_status').get()?.t || null
    } catch (e) {
      logger.error(`[admin] 概览统计失败：${e.message}`)
    }
    return result
  }

  // ---------------------------------------------------------------- CK 校验

  /** 校验单个 CK，返回 {ckStatus, httpCode, errMsg, costMs} */
  async _verifyOne(ltuid) {
    const bot = this.db.getBotDb()
    const row = bot.prepare('SELECT ck, device FROM MysUsers WHERE ltuid = ?').get(Number(ltuid))
    if (!row?.ck) {
      return {ckStatus: 'expired', errMsg: 'CK 为空', httpCode: null, costMs: 0}
    }

    const query = `uid=${ltuid}`
    const url = `https://api-takumi-record.mihoyo.com/game_record/card/wapi/getGameRecordCard?${query}`
    const began = Date.now()
    try {
      const res = await fetch(url, {
        headers: {
          'x-rpc-app_version': CN_CLIENT.app_version,
          'x-rpc-client_type': CN_CLIENT.client_type,
          'x-rpc-device_id': String(row.device || '').toUpperCase() || undefined,
          'User-Agent': CN_CLIENT.userAgent,
          Origin: CN_CLIENT.origin,
          'X-Requested-With': 'com.mihoyo.hyperion',
          Referer: 'https://webstatic.mihoyo.com/',
          Accept: 'application/json, text/plain, */*',
          Cookie: row.ck,
          DS: signDs(query),
        },
        signal: AbortSignal.timeout(8000),
      })
      const costMs = Date.now() - began
      const data = await res.json().catch(() => ({}))
      const retcode = Number(data.retcode)
      if (retcode === 0) {
        return {ckStatus: 'ok', httpCode: res.status, errMsg: null, costMs}
      }
      const expiredCodes = [-100, -101, 10001]
      return {
        ckStatus: expiredCodes.includes(retcode) ? 'expired' : 'error',
        httpCode: res.status,
        errMsg: `${retcode} ${data.message || ''}`.trim(),
        costMs,
      }
    } catch (e) {
      return {ckStatus: 'error', httpCode: null, errMsg: e.message, costMs: Date.now() - began}
    }
  }

  /** 批量校验（并发 + 间隔，避免触发风控） */
  async verifyAccounts(ltuids = [], concurrency = 3) {
    const unique = [...new Set(ltuids.map(Number).filter(Boolean))].slice(0, 20)
    if (!unique.length) {
      return {total: 0, ok: 0, expired: 0, detail: []}
    }
    const admin = this.db.getAdminDb()
    const stmt = admin.prepare(
      `INSERT INTO account_status (ltuid, ck_status, http_code, err_msg, cost_ms, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ltuid) DO UPDATE SET
         ck_status = excluded.ck_status,
         http_code = excluded.http_code,
         err_msg   = excluded.err_msg,
         cost_ms   = excluded.cost_ms,
         checked_at= excluded.checked_at`,
    )

    const results = new Array(unique.length)
    let cursor = 0
    const workers = Array.from({length: Math.min(Math.max(1, concurrency), unique.length)}, async () => {
      while (cursor < unique.length) {
        const i = cursor++
        const ltuid = unique[i]
        const res = await this._verifyOne(ltuid)
        results[i] = {ltuid, ...res}
        stmt.run(ltuid, res.ckStatus, res.httpCode, res.errMsg, res.costMs, new Date().toISOString())
        await sleep(800)
      }
    })
    await Promise.all(workers)

    return {
      total: results.length,
      ok: results.filter((r) => r.ckStatus === 'ok').length,
      expired: results.filter((r) => r.ckStatus === 'expired').length,
      detail: results.map((r) => ({ltuid: r.ltuid, ckStatus: r.ckStatus, errMsg: r.errMsg})),
    }
  }

  // ---------------------------------------------------------------- 群数据

  /** 群列表（第 1 期仅基本信息 + 今日统计快照） */
  queryGroups() {
    const groups = []
    const gl = global.Bot?.gl
    if (gl && typeof gl.forEach === 'function') {
      gl.forEach((g, gid) => {
        groups.push({
          gid: String(gid),
          name: g?.group_name || g?.name || String(gid),
          memberCount: g?.member_count ?? null,
        })
      })
    }
    let stats = []
    try {
      stats = this.db.getAdminDb().prepare('SELECT * FROM group_stats ORDER BY stat_date DESC LIMIT 500').all()
    } catch {}
    const byGid = new Map()
    for (const s of stats) {
      if (!byGid.has(s.gid)) byGid.set(s.gid, s)
    }
    return groups.map((g) => {
      const s = byGid.get(g.gid)
      return {
        ...g,
        active7d: s?.active_cnt ?? 0,
        msg7d: s?.msg_cnt ?? 0,
        join7d: s?.join_cnt ?? 0,
        leave7d: s?.leave_cnt ?? 0,
        updatedAt: s?.updated_at ?? null,
      }
    })
  }
}
