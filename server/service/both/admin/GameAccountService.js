import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 游戏账号聚合服务（米游社 6 游戏 + 鸣潮库街区）
 *
 * 数据来源：
 *  - 米游社：Bot 主库 MysUsers（ltuid / ck / uids JSON）+ admin.db account_status（CK 校验结果）
 *  - Stoken：Lotus-Plugin 的 data/users/*.yaml（account.stoken / game_roles），只读、只取布尔与昵称
 *  - 鸣潮：Redis `Yz:wavesJs:users` + `Yz:wavesJs:user:<qq>`（库街区 token 体系，与米游社无关）
 *
 * 安全：任何响应都不返回 CK / stoken 原文，只返回是否已存与来源标记。
 */

const LOTUS_USER_DIR = path.join(_paths.pluginRoot, '..', 'Lotus-Plugin', 'data', 'users')
const WAVES_USERS_KEY = 'Yz:wavesJs:users'
const WAVES_USER_KEY = (qq) => `Yz:wavesJs:user:${qq}`
const CACHE_TTL = 60 * 1000

/** 游戏元数据（前端侧栏 / 卡片直接用这份，避免两端各写一遍） */
export const GAME_META = [
  {key: 'gs', name: '原神', en: 'GENSHIN IMPACT', char: '原', source: 'mihoyo', from: '#D9B443', to: '#B5881C', fg: '#2A1E00'},
  {key: 'sr', name: '崩坏：星穹铁道', en: 'HONKAI STAR RAIL', char: '星', source: 'mihoyo', from: '#717DFF', to: '#4A55D8', fg: '#FFFFFF'},
  {key: 'zzz', name: '绝区零', en: 'ZENLESS ZONE ZERO', char: '绝', source: 'mihoyo', from: '#F3D451', to: '#D8A62B', fg: '#231C00'},
  {key: 'wd', name: '未定事件簿', en: 'TEARS OF THEMIS', char: '未', source: 'mihoyo', from: '#F093BA', to: '#D06290', fg: '#2B0716'},
  {key: 'bh3', name: '崩坏3', en: 'HONKAI IMPACT 3RD', char: '崩', source: 'mihoyo', from: '#52C5F7', to: '#2E86C6', fg: '#04202E'},
  {key: 'bh2', name: '崩坏学园2', en: 'HONKAI GAKUEN 2', char: '学', source: 'mihoyo', from: '#6CCB8E', to: '#3D9961', fg: '#04210F'},
  {key: 'waves', name: '鸣潮', en: 'WUTHERING WAVES', char: '潮', source: 'waves', from: '#4FC3D9', to: '#2E86C6', fg: '#04222B'},
]

const MIHOYO_KEYS = GAME_META.filter((g) => g.source === 'mihoyo').map((g) => g.key)

function parseUids(json) {
  try {
    const obj = JSON.parse(json || '{}')
    const ret = {}
    for (const key of MIHOYO_KEYS) {
      const arr = obj[key]
      ret[key] = Array.isArray(arr) ? arr.filter(Boolean).map(String) : []
    }
    return ret
  } catch {
    return MIHOYO_KEYS.reduce((acc, k) => ({...acc, [k]: []}), {})
  }
}

function maskCk(ck) {
  const s = String(ck || '')
  if (!s) return ''
  const matched = /ltoken=([^;]+)/.exec(s)
  const token = matched ? matched[1] : s
  if (token.length <= 12) return 'ltoken=****'
  return `ltoken=${token.slice(0, 8)}****${token.slice(-4)}`
}

export class GameAccountService extends Service {

  dbService = autowired('dbService')
  adminService = autowired('adminService')
  statsService = autowired('statsService')

  constructor(app) {
    super(app)
    this._lotusCache = null
  }

  get db() {
    return this.dbService
  }

  /* ----------------------------- Lotus stoken 适配 ----------------------------- */

  /**
   * 读取 Lotus-Plugin 的用户档案，构建 ltuid -> {hasStoken, stuid, roles}
   * 只取「有没有 stoken」与游戏角色昵称/等级，绝不外泄 token 原文。
   */
  _lotusMap(force = false) {
    if (!force && this._lotusCache && Date.now() - this._lotusCache.ts < CACHE_TTL) {
      return this._lotusCache.map
    }
    const map = new Map()
    try {
      if (fs.existsSync(LOTUS_USER_DIR)) {
        const files = fs.readdirSync(LOTUS_USER_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(LOTUS_USER_DIR, file), 'utf8')
            const doc = YAML.parse(raw) || {}
            const account = doc.account || {}
            const ltuid = String(account.ltuid || '').trim()
            if (!ltuid) continue
            const roles = {}
            for (const key of MIHOYO_KEYS) {
              const list = account.game_roles?.[key]
              if (Array.isArray(list)) {
                roles[key] = list.map((r) => ({
                  uid: String(r.uid || r.game_uid || ''),
                  nickname: String(r.nickname || ''),
                  level: String(r.level || ''),
                }))
              }
            }
            map.set(ltuid, {
              file,
              hasStoken: !!String(account.stoken || '').trim(),
              hasLtoken: !!String(account.ltoken || '').trim(),
              stuid: String(account.stuid || '').trim(),
              roles,
            })
          } catch {
            /* 单个档案损坏不影响整体 */
          }
        }
      }
    } catch (e) {
      logger?.warn?.(`[admin] 读取 Lotus 档案失败：${e.message}`)
    }
    this._lotusCache = {ts: Date.now(), map}
    return map
  }

  /* ----------------------------- Redis（鸣潮） ----------------------------- */

  get _redis() {
    return globalThis.redis ?? null
  }

  async _sMembers(key) {
    const client = this._redis
    if (!client) return []
    try {
      const fn = client.sMembers || client.smembers
      const res = await fn.call(client, key)
      return Array.isArray(res) ? res : []
    } catch {
      return []
    }
  }

  async _get(key) {
    const client = this._redis
    if (!client) return null
    try {
      return await client.get(key)
    } catch {
      return null
    }
  }

  /** 鸣潮账号明细（每个 qq 下的账号数组） */
  async _wavesAccounts() {
    const list = []
    const qqs = await this._sMembers(WAVES_USERS_KEY)
    if (!qqs.length) return list
    const nameMap = this._nameMap()
    for (const qq of qqs) {
      const raw = await this._get(WAVES_USER_KEY(qq))
      if (!raw) continue
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        continue
      }
      const accounts = Array.isArray(data?.accounts) ? data.accounts : []
      for (const a of accounts) {
        const uid = String(a?.uid || '').trim()
        if (!uid) continue
        list.push({
          qq: String(qq),
          bindName: nameMap.get(String(qq)) || '',
          kuroUid: String(a?.kuroUid || ''),
          uid,
          roleName: String(a?.roleName || ''),
          server: String(a?.serverId || ''),
          hasToken: !!String(a?.token || '').trim(),
          tokenStatus: String(a?.status || 'unknown'),
          current: String(data?.currentUid || '') === uid,
        })
      }
    }
    return list
  }

  _nameMap() {
    try {
      const map = this.statsService?.getUserNameMap?.()
      return map instanceof Map ? map : new Map()
    } catch {
      return new Map()
    }
  }

  /* ----------------------------- 概览 / 绑定矩阵 ----------------------------- */

  /**
   * 各游戏绑定概览（用户统计页的游戏卡网格 + 账号页侧栏计数）
   * @returns {{games: object[], accounts: number, users: number}}
   */
  async overview(force = false) {
    const bot = this.db.getBotDb()
    const lotus = this._lotusMap(force)
    const totalAccounts = bot ? bot.prepare('SELECT COUNT(*) AS n FROM MysUsers').get().n : 0
    const waves = await this._wavesAccounts()

    const games = GAME_META.map((meta) => {
      if (meta.source === 'waves') {
        const accountSet = new Set(waves.map((w) => w.qq))
        const validToken = waves.filter((w) => w.hasToken && w.tokenStatus !== 'invalid').length
        return {
          ...meta,
          uidCount: waves.length,
          accountCount: accountSet.size,
          totalAccounts,
          rate: waves.length ? Math.round((validToken / waves.length) * 100) : 0,
          ckSaved: validToken,
          skSaved: 0,
          skSupported: false,
        }
      }
      let uidCount = 0
      let accountCount = 0
      let ckSaved = 0
      let skSaved = 0
      if (bot) {
        try {
          uidCount = bot
            .prepare(`SELECT COUNT(*) AS n FROM MysUsers m, json_each(m.uids) g, json_each(g.value) u
                      WHERE g.key = ? AND json_type(g.value) = 'array'`)
            .get(meta.key).n
        } catch {
          uidCount = 0
        }
        // 有该游戏 UID 的账号数 + 有 CK 的账号数
        const rows = bot
          .prepare(`SELECT ltuid, ck, json_extract(uids, '$.' || ?) AS arr FROM MysUsers WHERE json_array_length(json_extract(uids, '$.' || ?)) > 0`)
          .all(meta.key, meta.key)
        accountCount = rows.length
        for (const row of rows) {
          if (String(row.ck || '').trim()) ckSaved++
          if (lotus.get(String(row.ltuid))?.hasStoken) skSaved++
        }
      }
      return {
        ...meta,
        uidCount,
        accountCount,
        totalAccounts,
        rate: totalAccounts ? Math.round((accountCount / totalAccounts) * 100) : 0,
        ckSaved,
        skSaved,
        skSupported: true,
      }
    })

    return {games, accounts: totalAccounts, users: this._totalUsers(bot)}
  }

  _totalUsers(bot) {
    if (!bot) return 0
    try {
      return bot.prepare('SELECT COUNT(*) AS n FROM Users').get().n
    } catch {
      return 0
    }
  }

  /* ----------------------------- 单游戏账号明细 ----------------------------- */

  /**
   * 某游戏的账号列表（账号页手风琴）
   * @param {string} game gs/sr/zzz/wd/bh3/bh2/waves
   * @param {string} q    搜索：ltuid / 绑定标识 / UID / 角色名
   */
  async accounts(game, {q = ''} = {}) {
    const meta = GAME_META.find((g) => g.key === game)
    if (!meta) throw new Error(`未知游戏：${game}`)
    const keyword = String(q || '').trim().toLowerCase()

    if (meta.source === 'waves') {
      const waves = await this._wavesAccounts()
      let list = waves
      if (keyword) {
        list = list.filter((w) =>
          [w.uid, w.kuroUid, w.roleName, w.qq, w.bindName].some((v) => String(v || '').toLowerCase().includes(keyword)),
        )
      }
      list = [...list].sort((a, b) => Number(b.current) - Number(a.current) || a.uid.localeCompare(b.uid))
      return {
        game: meta.key,
        meta,
        total: list.length,
        list: list.map((w) => ({
          id: `waves:${w.qq}:${w.uid}`,
          ltuid: null,
          qq: w.qq,
          bindIds: [w.qq],
          bindNames: [w.bindName],
          uidCount: 1,
          hasCk: w.hasToken,
          hasSk: false,
          ckStatus: w.tokenStatus === 'invalid' ? 'expired' : w.hasToken ? 'ok' : 'unknown',
          ckMask: '',
          checkedAt: null,
          uids: [{
            uid: w.uid,
            nickname: w.roleName,
            level: '',
            kuroUid: w.kuroUid,
            server: w.server,
          }],
        })),
        hero: {
          uidCount: list.length,
          ckSaved: list.filter((w) => w.hasToken && w.tokenStatus !== 'invalid').length,
          skSaved: 0,
          skSupported: false,
          accountCount: new Set(list.map((w) => w.qq)).size,
        },
      }
    }

    const bot = this.db.getBotDb()
    const empty = {game: meta.key, meta, total: 0, list: [], hero: {uidCount: 0, ckSaved: 0, skSaved: 0, skSupported: true, accountCount: 0}}
    if (!bot) return empty

    const lotus = this._lotusMap()
    const bindMap = this.adminService?._bindMap?.() || new Map()
    const nameMap = this._nameMap()

    let rows = []
    try {
      rows = bot
        .prepare(`SELECT ltuid, type, ck, device_fp, uids, updatedAt FROM MysUsers
                  WHERE json_array_length(json_extract(uids, '$.' || ?)) > 0
                  ORDER BY ltuid`)
        .all(meta.key)
    } catch (e) {
      logger?.warn?.(`[admin] 读取 ${meta.key} 账号失败：${e.message}`)
      return empty
    }

    const statusMap = this.adminService?._statusMap?.(rows.map((r) => Number(r.ltuid))) || new Map()
    let list = rows.map((row) => {
      const ltuid = Number(row.ltuid)
      const uids = parseUids(row.uids)[meta.key] || []
      const profile = lotus.get(String(ltuid))
      const st = statusMap.get(ltuid)
      const bindIds = bindMap.get(ltuid) || []
      return {
        id: `mys:${ltuid}`,
        ltuid,
        bindIds,
        bindNames: bindIds.map((id) => nameMap.get(id) || ''),
        uidCount: uids.length,
        hasCk: !!String(row.ck || '').trim(),
        hasSk: !!profile?.hasStoken,
        ckStatus: st?.ck_status || 'unknown',
        ckMask: maskCk(row.ck),
        checkedAt: st?.checked_at || null,
        uids: uids.map((uid) => {
          const role = (profile?.roles?.[meta.key] || []).find((r) => r.uid === uid)
          return {
            uid,
            nickname: role?.nickname || '',
            level: role?.level || '',
          }
        }),
      }
    })

    if (keyword) {
      list = list.filter((a) =>
        [String(a.ltuid), ...a.bindIds, ...a.bindNames, ...a.uids.map((u) => `${u.uid} ${u.nickname}`)]
          .some((v) => String(v || '').toLowerCase().includes(keyword)),
      )
    }

    return {
      game: meta.key,
      meta,
      total: list.length,
      list,
      hero: {
        uidCount: list.reduce((n, a) => n + a.uidCount, 0),
        ckSaved: list.filter((a) => a.hasCk).length,
        skSaved: list.filter((a) => a.hasSk).length,
        skSupported: true,
        accountCount: list.length,
      },
    }
  }

  /** Stoken 状态明细（账号页第三个 tab） */
  async stokenReport(game = '') {
    const lotus = this._lotusMap()
    const bot = this.db.getBotDb()
    const rows = []
    if (bot) {
      const list = bot.prepare('SELECT ltuid, uids FROM MysUsers ORDER BY ltuid').all()
      for (const row of list) {
        const ltuid = Number(row.ltuid)
        const profile = lotus.get(String(ltuid))
        const uids = parseUids(row.uids)
        if (game && !(uids[game] || []).length) continue
        rows.push({
          ltuid,
          hasStoken: !!profile?.hasStoken,
          hasLtoken: !!profile?.hasLtoken,
          stuid: profile?.stuid || '',
          source: profile ? 'Lotus-Plugin' : '',
          uids: game ? uids[game] : MIHOYO_KEYS.reduce((acc, k) => acc + (uids[k] || []).length, 0),
        })
      }
    }
    return {total: rows.length, saved: rows.filter((r) => r.hasStoken).length, list: rows}
  }
}
