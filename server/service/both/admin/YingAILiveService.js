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
 * 这里不监听 YingAI 内部事件（那套框架庞杂、易碎），只做一件事：
 * 每 2 秒增量读「今日 + 昨日」文件尾部，按 ts 去重后灌进内存环形缓冲。
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
    logger?.mark?.(`[YingAI Live] 实时对话流已启动：${this.diagDir}`)
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
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
        this._push({...r, ts})
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

  /** 有实时流（今日有对话）的群列表，按最近活跃排序 */
  groups() {
    const map = new Map()
    for (let i = this._buf.length - 1; i >= 0; i--) {
      const r = this._buf[i]
      const gid = String(r.gid || '')
      if (!gid || map.has(gid)) continue
      map.set(gid, {
        gid,
        nick: String(r.nick || ''),
        lastTs: r.ts,
        lastReply: String(r.reply || '').slice(0, 40),
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
