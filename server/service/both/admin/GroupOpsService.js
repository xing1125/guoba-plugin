import fs from 'node:fs'
import path from 'node:path'
import {autowired, Service} from '#guoba.framework'

/**
 * 群操作服务（写操作 · 自用精简版）
 *
 * 与 group-manage/群管拓展.js 的 #清活跃 / #清拓展 指令保持同一套 Redis 键：
 *   活跃：Yz:GM:active(:activeM/activeW/activeD/activeN) / Yz:GMx:dayTotal(近60天)
 *   拓展：Yz:GMx:sign/streak/score/repeat/rpt/recall/risk/join/leave
 *   名单：Yz:GM:owner:<gid> / Yz:GM:groupAdmin:<gid> （Redis SET）
 *
 * 安全措施：
 *   - 只删插件统计数据，不碰用户账号/消息记录
 *   - 每次操作写操作日志到 Redis stream（保留最近 200 条，供后续审计用）
 */

const pad2 = (n) => String(n).padStart(2, '0')
const ymOf = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
const ymdOf = (d = new Date()) => `${ymOf(d)}-${pad2(d.getDate())}`
const weekKeySuffix = (d = new Date()) => {
  const onejan = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7)
  return `${d.getFullYear()}-W${pad2(week)}`
}

const EXT_PREFIXES = ['sign', 'streak', 'score', 'repeat', 'rpt', 'recall', 'risk', 'join', 'leave']

export class GroupOpsService extends Service {

  statsService = autowired('statsService')

  get redis() {
    return globalThis.redis ?? null
  }

  _normGid(raw) {
    return String(raw || '').trim().replace(/^group-/, '')
  }

  /** 归集一个群的待删键（scope=activity|ext|all） */
  _keysFor(gid, scope) {
    const keys = []
    const ymd = ymdOf()
    if (scope === 'activity' || scope === 'all') {
      keys.push(
        `Yz:GM:active:${gid}`,
        `Yz:GM:activeM:${ymOf()}:${gid}`,
        `Yz:GM:activeW:${weekKeySuffix()}:${gid}`,
        `Yz:GM:activeD:${ymd}:${gid}`,
        `Yz:GM:activeN:${ymd}:${gid}`,
      )
      // 近 60 天每日总量
      const d = new Date()
      for (let i = 0; i < 60; i++) {
        const x = new Date(d)
        x.setDate(d.getDate() - i)
        keys.push(`Yz:GMx:dayTotal:${ymdOf(x)}:${gid}`)
      }
    }
    if (scope === 'ext' || scope === 'all') {
      for (const p of EXT_PREFIXES) keys.push(`Yz:GMx:${p}:${gid}`)
    }
    return keys
  }

  /**
   * 批量清群数据
   * @param {string[]} gids 群号列表
   * @param {'activity'|'ext'|'all'|'trace'} scope
   *   activity=活跃榜 ext=签到/积分/复读等
   *   all=activity+ext
   *   trace=彻底清除残留（all + Yz:count 计数键 + 群主/群管名单 + AI 开关记录），
   *   用于「Bot 已退群」的群——否则检测会因 Yz:count 残留一直列出该群
   * @returns {{total:number, results:{gid:number}[]}}
   */
  async clearGroups(gids, scope = 'activity') {
    const client = this.redis
    if (!client) throw new Error('Redis 未就绪')
    if (!['activity', 'ext', 'all', 'trace'].includes(scope)) throw new Error(`不支持的清除范围：${scope}`)
    const list = [...new Set((gids || []).map((g) => this._normGid(gidOf(g))))]
    if (!list.length) throw new Error('未指定群号')
    if (list.length > 200) throw new Error('单次最多操作 200 个群')

    const results = []
    let total = 0
    for (const gid of list) {
      const keys = scope === 'trace' ? this._traceKeysFor(gid) : this._keysFor(gid, scope)
      let n = 0
      try {
        n = Number(await client.sendCommand(['DEL', ...keys])) || 0
      } catch {
        // Redis v3 兼容：逐个删
        for (const k of keys) {
          try { n += Number(await client.del(k)) || 0 } catch { /* 忽略 */ }
        }
      }
      if (scope === 'trace') {
        n += await this._scanDelCountKeys(gid)
        // AI 开关名单里去掉该群
        try { await client.sendCommand(['SREM', 'Yz:GMx:aiOff', gid]) } catch { /* 忽略 */ }
      }
      total += n
      results.push({gid, deleted: n})
    }
    await this._log({action: `clear:${scope}`, detail: {gids: list, deleted: total}})
    return {total, results}
  }

  /** trace 范围的固定键：all + 群主/群管名单 */
  _traceKeysFor(gid) {
    return [
      ...this._keysFor(gid, 'all'),
      `Yz:GM:owner:${gid}`,
      `Yz:GM:groupAdmin:${gid}`,
    ]
  }

  /** SCAN 删除某群在 Yz:count 下的消息计数键（含 group- 前缀变体），返回删除数 */
  async _scanDelCountKeys(gid) {
    const client = this.redis
    if (!client) return 0
    const patterns = [
      `Yz:count:*:group:${gid}:*`,
      `Yz:count:*:group-${gid}:*`,
      `Yz:count:*:group:${gid}`,
      `Yz:count:*:group-${gid}`,
    ]
    let deleted = 0
    for (const pattern of patterns) {
      let cursor = '0'
      try {
        do {
          const res = await client.sendCommand(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500'])
          cursor = Array.isArray(res) ? String(res[0]) : String(res?.cursor ?? '0')
          const keys = Array.isArray(res) ? res[1] : (res?.keys || [])
          if (keys?.length) {
            try {
              deleted += Number(await client.sendCommand(['DEL', ...keys.map(String)])) || 0
            } catch {
              for (const k of keys) {
                try { deleted += Number(await client.del(String(k))) || 0 } catch { /* 忽略 */ }
              }
            }
          }
        } while (cursor !== '0')
      } catch { /* 单个 pattern 失败不阻断 */ }
    }
    return deleted
  }

  /** 某群的群主/群管名单（Redis SET） */
  async getGroupRoles(gidRaw) {
    const client = this.redis
    if (!client) throw new Error('Redis 未就绪')
    const gid = this._normGid(gidRaw)
    const [owner, admin] = await Promise.all([
      client.sendCommand(['SMEMBERS', `Yz:GM:owner:${gid}`]).catch(() => []),
      client.sendCommand(['SMEMBERS', `Yz:GM:groupAdmin:${gid}`]).catch(() => []),
    ])
    return {
      gid,
      owner: (owner || []).map(String),
      groupAdmin: (admin || []).map(String),
    }
  }

  /**
   * 设置/取消 群主或群管理员
   * @param {string} gidRaw 群号
   * @param {'owner'|'groupAdmin'} role
   * @param {string|string[]} uids 用户 ID（wxid 或数字）
   * @param {boolean} add true=添加 false=移除
   */
  async setGroupRole(gidRaw, role, uids, add = true) {
    const client = this.redis
    if (!client) throw new Error('Redis 未就绪')
    const gid = this._normGid(gidRaw)
    if (!['owner', 'groupAdmin'].includes(role)) throw new Error(`不支持的身份：${role}`)
    const ids = (Array.isArray(uids) ? uids : [uids]).map((u) => String(u || '').trim()).filter(Boolean)
    if (!ids.length) throw new Error('未指定用户 ID')
    if (!gid.includes('@chatroom') && !/^\d+$/.test(gid)) throw new Error(`群号不合法：${gid}`)
    const key = role === 'owner' ? `Yz:GM:owner:${gid}` : `Yz:GM:groupAdmin:${gid}`
    let n = 0
    for (const uid of ids) {
      try {
        n += add
          ? Number(await client.sendCommand(['SADD', key, uid])) || 0
          : Number(await client.sendCommand(['SREM', key, uid])) || 0
      } catch (e) {
        throw new Error(`写入名单失败：${e.message}`)
      }
    }
    await this._log({action: `${add ? 'add' : 'remove'}:${role}`, detail: {gid, uids: ids}})
    return {gid, role, changed: n}
  }

  /** 操作日志：Redis list，保留最近 200 条（自用审计，暂不做 UI） */
  async _log({action, detail}) {
    try {
      const client = this.redis
      const entry = JSON.stringify({
        at: new Date().toISOString(),
        action,
        detail,
        by: 'guoba-console',
      })
      await client.sendCommand(['RPUSH', 'Yz:GMx:opsLog', entry])
      await client.sendCommand(['LTRIM', 'Yz:GMx:opsLog', '-200', '-1'])
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 读取操作日志（最新在前） */
  async getOpsLog(limit = 50) {
    const client = this.redis
    if (!client) return {available: false, list: []}
    const n = Math.min(200, Math.max(1, Number(limit) || 50))
    const raw = await client.sendCommand(['LRANGE', 'Yz:GMx:opsLog', String(-n), '-1']).catch(() => [])
    const list = []
    for (const line of (raw || []).slice(-n).reverse()) {
      try {
        list.push(JSON.parse(String(line)))
      } catch {
        /* 跳过坏行 */
      }
    }
    return {available: true, list}
  }

  /* --------------------------- AI 分群开关 --------------------------- */

  /** YingAI 分群配置目录（data/groups/<gid>.json，enabled 字段） */
  _yingGroupsDir() {
    return path.resolve(process.cwd(), 'plugins', 'YingAI', 'data', 'groups')
  }

  _readYingEnabled(gid) {
    try {
      const p = path.join(this._yingGroupsDir(), `${gid}.json`)
      if (!fs.existsSync(p)) return true // 默认开启
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      return j?.enabled !== false
    } catch {
      return true
    }
  }

  _writeYingEnabled(gid, enabled) {
    const dir = this._yingGroupsDir()
    fs.mkdirSync(dir, {recursive: true})
    const p = path.join(dir, `${gid}.json`)
    let cfg = {}
    try {
      if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8')) || {}
    } catch {
      cfg = {}
    }
    cfg.enabled = !!enabled
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8')
  }

  /**
   * 批量查 AI 开关状态
   * @returns {{ying: Record<gid,boolean>, gm: Record<gid,boolean>}} true=开启
   */
  async getAISwitches(gids) {
    const client = this.redis
    const list = [...new Set((gids || []).map((g) => this._normGid(g)))].slice(0, 300)
    const ying = {}
    const gm = {}
    let gmOff = new Set()
    try {
      const raw = await client.sendCommand(['SMEMBERS', 'Yz:GMx:aiOff'])
      gmOff = new Set((raw || []).map(String))
    } catch {
      /* 名单读不到则全部视为开启 */
    }
    for (const gid of list) {
      ying[gid] = this._readYingEnabled(gid)
      gm[gid] = !gmOff.has(gid)
    }
    return {ying, gm}
  }

  /**
   * 批量设置 AI 分群开关
   * @param {'ying'|'gm'} scope ying=荧(YingAI) gm=群管拓展AI
   * @param {string[]} gids
   * @param {boolean} off true=关闭该群 AI
   */
  async setAISwitch(scope, gids, off) {
    const client = this.redis
    if (!client) throw new Error('Redis 未就绪')
    if (!['ying', 'gm'].includes(scope)) throw new Error(`不支持的范围：${scope}`)
    const list = [...new Set((gids || []).map((g) => this._normGid(g)))]
    if (!list.length) throw new Error('未指定群号')
    if (list.length > 200) throw new Error('单次最多操作 200 个群')

    for (const gid of list) {
      if (scope === 'ying') {
        this._writeYingEnabled(gid, !off)
      } else {
        const key = 'Yz:GMx:aiOff'
        if (off) await client.sendCommand(['SADD', key, gid])
        else await client.sendCommand(['SREM', key, gid])
      }
    }
    await this._log({action: `ai:${scope}:${off ? 'off' : 'on'}`, detail: {gids: list}})
    return {scope, off, changed: list.length}
  }

  /* ---------------------------- 无效群检测 / 退群 ---------------------------- */

  /**
   * 所有 Bot 当前在群的 gid 集合（运行时数据，来自各适配器 bot.gl，非持久化）。
   * @returns {Map<string, string[]>} gid -> 所在 bot uin 列表
   */
  _botGroupGids() {
    const Bot = globalThis.Bot
    const bots = Bot?.bots instanceof Map ? [...Bot.bots.values()] : Object.values(Bot?.bots || {})
    const map = new Map()
    for (const b of bots) {
      const uin = String(b?.uin ?? '')
      let keys = []
      if (b?.gl instanceof Map) keys = [...b.gl.keys()]
      else if (b?.gl && typeof b.gl === 'object') keys = Object.keys(b.gl)
      for (const raw of keys) {
        const gid = this._normGid(gidOf(raw))
        if (!gid) continue
        if (!map.has(gid)) map.set(gid, [])
        if (uin && !map.get(gid).includes(uin)) map.get(gid).push(uin)
      }
    }
    return map
  }

  /**
   * 无效群检测：对比「Redis 有计数数据的群」与「Bot 当前群列表」。
   * - left：Bot 已退出的群（数据残留）
   * - idle：还在群但近 14 天零消息（daily 窗口只有 14 天，故按 14 天窗口判定）
   * - low：还在群但近 14 天消息量低于阈值（仅标记提醒，不默认选中）
   */
  async getInvalidGroups(lowLimit = 100) {
    const snapshot = await this.statsService.snapshotGroups()
    const groups = snapshot || []
    const inGroups = this._botGroupGids()
    const left = []
    const idle = []
    const low = []
    for (const g of groups) {
      const gid = this._normGid(gidOf(g.gid))
      if (!gid) continue
      const item = {
        gid,
        name: g.name || '',
        total: g.total || 0,
        lastDate: g.lastDate || null,
        recent14: (g.daily || []).reduce((s, d) => s + (d.n || 0), 0),
        botUins: inGroups.get(gid) || [],
      }
      if (!inGroups.has(gid)) {
        left.push(item)
      } else if (item.recent14 === 0) {
        idle.push(item)
      } else if (item.recent14 < lowLimit) {
        low.push(item)
      }
    }
    return {
      available: true,
      botGroupCount: inGroups.size,
      trackedCount: groups.length,
      left,
      idle,
      low,
      updatedAt: new Date().toISOString(),
    }
  }

  /** 让所有在该群的 Bot 退群（高危，调用方必须先确认） */
  async quitGroup(gidRaw) {
    const gid = this._normGid(gidOf(gidRaw))
    if (!gid) throw new Error('无效群号')
    const Bot = globalThis.Bot
    if (!Bot) throw new Error('Bot 未就绪')
    const inGroups = this._botGroupGids()
    const uins = inGroups.get(gid)
    if (!uins || !uins.length) throw new Error('没有 Bot 在该群，无需退群')
    if (typeof Bot.pickGroup !== 'function') throw new Error('当前适配器不支持退群操作')
    const group = Bot.pickGroup(gid)
    if (!group || typeof group.quit !== 'function') throw new Error('当前适配器不支持退群操作')
    await group.quit()
    await this._log({action: 'quit', detail: {gid, bots: uins}})
    return {gid, bots: uins}
  }
}

// gids 里可能是 {gid: xxx} 形态（防呆），统一取值
function gidOf(v) {
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (v && typeof v === 'object') return String(v.gid ?? v.group_id ?? '')
  return ''
}
