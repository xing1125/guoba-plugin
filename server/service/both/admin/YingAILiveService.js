import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 荧（YingAI）实时对话流服务
 *
 * 目标：在后台控制台看到「荧在群里说了什么 / 回了谁」，并支持以 Bot 身份代发。
 *
 * 数据源与口径：**零侵入**复用 YingAI 自己的诊断文件
 *   <plugins>/YingAI/data/diag/YYYY-MM-DD.jsonl
 * 每一行是一条「谁说了什么 → 荧回了什么」的记录：
 *   { ts, gid, uid, nick, msg, reply, model, fellBack, strategy, ... }
 *
 * 这里不监听 YingAI 内部事件（那套框架庞杂、易碎），只做两件事：
 * 1. 每 2 秒增量读「今日 + 昨日」文件尾部，按 ts 去重后灌进内存环形缓冲（荧的回复对）
 * 2. 挂一个 Bot 全局 message 监听，把「群友说话但荧没回」的普通群消息也收进来
 *    （source: 'diag' = 荧的问答对，'chat' = 普通群消息；同一句话优先保留 diag 行，chat 行会被剔除）
 * 前端用 after=<ts> 增量拉取即可得到准实时流。
 *
 * 「代发」复用 ConsoleService.send（Bot 身份直发，协议端不经过插件）。
 */
export class YingAILiveService extends Service {

  consoleService = autowired('consoleService')

  constructor(app) {
    super(app)
    /** 荧的诊断目录：<plugins>/YingAI/data/diag（_paths.pluginRoot = Guoba-Plugin 根，同级即 YingAI） */
    this.diagDir = path.resolve(_paths.pluginRoot, '..', 'YingAI', 'data', 'diag')
    /** 环形缓冲：只保留最近 N 条，避免内存无限增长 */
    this._buf = []
    this._max = 2000
    /** 已见过的 ts（跨轮去重） */
    this._seen = new Set()
    /** 缓冲里最大的 ts（供增量读取起点） */
    this._maxTs = 0
    /** 后台代发缓存：send 成功后立即 push 进流，让「我发的」和「荧回的」同屏 */
    this._inject = []
    /** diag 里出现过的 msg key（chat 监听见到同 key 就跳过，避免同一句话出现两行） */
    this._diagKeys = new Set()
    /** chat 监听自己的近端去重（防 Bot.em 重复派发） */
    this._recentChat = new Set()
    /** 全局消息监听句柄（stop 时卸载） */
    this._listener = null
    this._timer = null
  }

  get bot() {
    return globalThis.Bot ?? null
  }

  /* ---------------------------------------------------------------- 常驻巡检 */

  start() {
    if (this._timer) return
    // 启动先预热一轮（把已有历史加载进来），再进入 2 秒巡检
    this._scan().catch(() => {})
    this._timer = setInterval(() => this._scan().catch(() => {}), 2000)
    this._timer.unref?.()
    this._attachListener()
    logger?.mark?.(`[YingAI Live] 实时对话流已启动：${this.diagDir}`)
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    if (this._listener) {
      try { this.bot?.off?.('message', this._listener) } catch {}
      this._listener = null
    }
  }

  /**
   * 挂全局 message 监听：收集「群友说话但荧没回」的普通群消息。
   * 与 diag 行同 key（gid|uid|msg）的去重：diag 优先，chat 行让位。
   */
  _attachListener() {
    if (this._listener || typeof this.bot?.on !== 'function') return
    this._listener = (e) => {
      try {
        if (!e || !e.isGroup || e.reply_to) { /* 只收群消息 */ }
        const msg = this._msgText(e.msg)
        if (!msg) return
        // 跳过 Bot 自己发的（含后台代发回环）
        if (e.user_id && e.self_id && String(e.user_id) === String(e.self_id)) return
        const gid = String(e.group_id ?? '').replace('@chatroom', '')
        if (!gid || /^__probe_/.test(gid)) return
        const uid = String(e.user_id ?? '')
        const nick = String(e.sender?.card || e.sender?.nickname || e.member?.nick || '')
        const row = {
          ts: Number(e.time ? e.time * 1000 : Date.now()) || Date.now(),
          gid, uid, nick, msg, reply: '',
          model: '', fellBack: false, strategy: '',
          source: 'chat',
        }
        const key = this._msgKey(row)
        if (this._diagKeys.has(key) || this._recentChat.has(key)) return
        this._recentChat.add(key)
        if (this._recentChat.size > 5000) this._recentChat.clear()
        row._key = key
        this._push(row)
      } catch { /* 监听绝不能抛错影响消息链路 */ }
    }
    try { this.bot.on('message', this._listener) } catch {}
  }

  /** e.msg 可能是字符串（QQ）或分段数组（微信适配器），统一抽成纯文本 */
  _msgText(raw) {
    if (typeof raw === 'string') return raw.trim()
    if (Array.isArray(raw)) {
      return raw
        .map((s) => (typeof s === 'string' ? s : s?.type === 'text' ? s?.data?.text ?? '' : ''))
        .join('')
        .trim()
    }
    return ''
  }

  /**
   * 读今日 + 昨日文件（跨零点不至于断流），只取 ts > _maxTs 的新行。
   * 用 readFileSync 读尾部是安全的：单日文件几 MB，2 秒一读代价可忽略。
   */
  async _scan() {
    const files = this._todayFiles()
    let maxSeen = this._maxTs
    for (const file of files) {
      if (!fs.existsSync(file)) continue
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        let r
        try { r = JSON.parse(t) } catch { continue }
        if (!r || !r.reply) continue
        // 探针行剔除（与 diagStats.isProbe 同口径）
        if (this._isProbe(r)) continue
        const ts = Number(r.ts) || 0
        if (ts <= maxSeen || this._seen.has(ts)) continue
        this._seen.add(ts)
        if (this._seen.size > 50000) this._seen.clear()
        const row = {...r, ts, source: 'diag'}
        // 同一句话：diag 优先，把之前 chat 监听收进来的那行剔掉
        const key = this._msgKey(row)
        this._diagKeys.add(key)
        if (this._diagKeys.size > 20000) this._diagKeys.clear()
        if (this._buf.some((b) => b.source === 'chat' && b._key === key)) {
          this._buf = this._buf.filter((b) => !(b.source === 'chat' && b._key === key))
        }
        this._push(row)
        if (ts > this._maxTs) this._maxTs = ts
      }
    }
    // 把积压的代发也并进去（时间戳用注入时的真实值）
    if (this._inject.length) {
      for (const it of this._inject) this._push(it)
      this._inject = []
    }
  }

  _todayFiles() {
    const out = []
    const now = new Date()
    for (let i = 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000)
      out.push(path.join(this.diagDir, this._dateStr(d) + '.jsonl'))
    }
    return out
  }

  _dateStr(d) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  _isProbe(r) {
    return /^__probe_/.test(String(r.gid || '')) || /probe/.test(String(r.model || ''))
  }

  /** 同一句话的去重 key：群 + 人 + 内容前 120 字 */
  _msgKey(r) {
    return `${r.gid}|${r.uid}|${String(r.msg || '').slice(0, 120)}`
  }

  _push(r) {
    this._buf.push(r)
    if (this._buf.length > this._max) this._buf.splice(0, this._buf.length - this._max)
  }

  /* ---------------------------------------------------------------- 对外查询 */

  /**
   * 增量拉取：after 之后的对话流（按时间升序），可选 gid 过滤。
   * 返回最新的游标（max ts），前端下次带上。
   */
  stream({after = 0, gid = '', limit = 200} = {}) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    const from = Number(after) || 0
    let list = this._buf.filter((r) => r.ts > from)
    if (gid) list = list.filter((r) => String(r.gid) === String(gid))
    // 只回最近 n 条（缓冲本身按时间序追加）
    const out = list.slice(-n)
    return {
      rows: out,
      cursor: this._maxTs,
      count: out.length,
      total: this._buf.length,
    }
  }

  /** 从运行时 Bot.gl 里解析群名（群名没有持久化，唯一来源是各 bot 的内存群列表） */
  _groupName(gid) {
    const raw = String(gid || '')
    if (!raw) return ''
    for (const bot of Object.values(this.bot ?? {})) {
      const gl = bot?.gl
      if (!gl?.get) continue
      const candidates = [raw, Number(raw), raw + '@chatroom']
      for (const k of candidates) {
        const g = gl.get(k)
        if (g?.group_name) return String(g.group_name)
      }
    }
    return ''
  }

  /** 有实时流（今日有消息）的群列表，按最近活跃排序，带群名 */
  groups() {
    const map = new Map()
    for (let i = this._buf.length - 1; i >= 0; i--) {
      const r = this._buf[i]
      const gid = String(r.gid || '')
      if (!gid || map.has(gid)) continue
      map.set(gid, {
        gid,
        name: this._groupName(gid),
        nick: String(r.nick || ''),
        lastTs: r.ts,
        lastReply: String(r.reply || r.msg || '').slice(0, 40),
      })
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs)
  }

  /**
   * 以 Bot 身份往指定群发一条消息（代发）。
   * 返回后立刻把这条「我发的」注入实时流，前端能马上看到自己发的和荧的后续回复。
   */
  async reply({gid, text} = {}) {
    const txt = String(text || '').trim()
    if (!txt) throw new Error('回复内容不能为空')
    const res = await this.consoleService.send({kind: 'group', id: gid, text: txt})
    // 注入一条「后台代发」伪记录（ts 用当前毫秒，gid 归一）
    const gidNorm = String(res?.id || gid)
    this._inject.push({
      ts: Date.now(),
      gid: gidNorm,
      uid: '',
      nick: '后台',
      msg: '',
      reply: txt,
      model: '',
      fellBack: false,
      strategy: '',
      fromConsole: true,
    })
    return res
  }
}

export default YingAILiveService
