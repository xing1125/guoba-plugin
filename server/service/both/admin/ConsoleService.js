import {autowired, Service} from '#guoba.framework'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

/**
 * 后台控制台服务（写操作 · 与 Bot 同进程）
 *
 * 两件事：
 *   1. 以 Bot 身份往指定群/好友发消息
 *   2. 模拟一条消息事件，走一遍真实插件链路（loader.deal），把回复捕获回来
 *
 * 关键设计：
 *   - 走 Bot.em('message', data) 这条公开入口，不直连 loader，保证黑白名单/冷却/统计照常生效
 *   - data.reply 预先注入，prepareEvent 只在 reply 缺失时才覆盖，因此能把回复劫持成"预览"
 *   - 群聊必须带 at 段（atBot=true），否则 onlyReplyAt 会把规则全部跳过
 *   - 危险指令默认拒绝，需 confirm 才放行
 */

/**
 * 可能影响 Bot 运行的指令，需二次确认。
 * 注意：不能用 \b —— 中文不是 \w，词边界断言永远失败，导致 "#重启" 漏拦。
 * 用负向先行断言：关键词后面不能再跟中文/字母/数字。
 */
const DANGEROUS_RE =
  /^\s*[#＃/＊*]?\s*(重启|关机|停机|退出|下线|更新|升级|重载|安装插件|卸载插件|reset|exit|stop|restart|update|upgrade|reload|reboot)(?![\u4e00-\u9fa5A-Za-z0-9])/i

/** 单次最多捕获的回复条数 / 单条最大长度 */
const MAX_REPLIES = 12
const MAX_TEXT = 4000

/** 历史记录 Redis 键与保留条数 */
const HISTORY_KEY = 'Yz:Guoba:console:history'
const HISTORY_MAX = 100

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 消息段 → 纯文本（用于预览） */
export function segToText(msg) {
  if (msg == null) return ''
  if (typeof msg === 'string') return msg
  if (Buffer.isBuffer(msg)) return `[Buffer ${msg.length}B]`
  if (Array.isArray(msg)) return msg.map(segToText).join('')
  if (typeof msg === 'object') {
    if (msg.type === 'text') return String(msg.text ?? msg.data?.text ?? '')
    if (msg.type === 'at') return `@${msg.qq ?? msg.data?.qq ?? ''}`
    if (msg.type === 'image') return '[图片]'
    if (msg.type === 'face') return '[表情]'
    if (msg.type === 'record') return '[语音]'
    if (msg.type === 'video') return '[视频]'
    if (msg.type === 'file') return '[文件]'
    if (msg.type === 'reply') return ''
    return `[${msg.type || 'unknown'}]`
  }
  return String(msg)
}

export class ConsoleService extends Service {

  dbService = autowired('dbService')

  /** 简易节流：60 秒内最多 20 次执行 */
  _hits = []

  get bot() {
    return globalThis.Bot ?? null
  }

  get redis() {
    return globalThis.redis ?? null
  }

  /** 机器人 + 目标概览 */
  async status() {
    const bot = this.bot
    const selfId = this._realSelfId()
    await this._getYzCfg()
    return {
      online: !!selfId,
      uins: bot?.uin ? Array.from(bot.uin) : [],
      groupCount: bot?.gl ? bot.gl.size : 0,
      friendCount: bot?.fl ? bot.fl.size : 0,
      selfId,
      master: this._masterQQ(selfId),
    }
  }

  /** 真实协议端 Bot（排除 stdin 等模拟账号） */
  _realSelfId() {
    const bot = this.bot
    if (!bot?.bots) return ''
    for (const uin of bot.uin ?? []) {
      const b = bot.bots[uin]
      if (b && uin !== 'stdin' && b.adapter?.id) return String(uin)
    }
    for (const [uin, b] of Object.entries(bot.bots)) {
      if (uin !== 'stdin' && b?.adapter?.id) return String(uin)
    }
    return ''
  }

  /** 群 / 好友目标列表（带关键字过滤） */
  async targets(kind = 'group', keyword = '') {
    const bot = this.bot
    if (!bot) return []
    const kw = String(keyword || '').trim().toLowerCase()
    const out = []
    if (kind === 'friend') {
      for (const [id, f] of bot.fl ?? []) {
        if (String(id) === 'stdin') continue
        const name = f?.nickname || f?.name || f?.remark || ''
        if (kw && !`${id}${name}`.toLowerCase().includes(kw)) continue
        out.push({ id: String(id), name: String(name || id), botId: String(f?.bot_id ?? '') })
      }
    } else {
      for (const [id, g] of bot.gl ?? []) {
        if (String(id) === 'stdin') continue
        const name = g?.group_name || g?.name || ''
        if (kw && !`${id}${name}`.toLowerCase().includes(kw)) continue
        out.push({
          id: String(id),
          name: String(name || id),
          count: g?.member_count ?? g?.memberCount ?? g?.member_num ?? 0,
          botId: String(g?.bot_id ?? ''),
        })
      }
    }
    out.sort((a, b) => b.id.localeCompare(a.id))
    return out.slice(0, 500)
  }

  /** 以 Bot 身份发送消息 */
  async send({kind = 'group', id, text, botId} = {}) {
    const target = this._checkTarget(kind, id)
    const msg = String(text ?? '')
    if (!msg.trim()) throw new Error('消息内容不能为空')
    if (msg.length > MAX_TEXT) throw new Error(`消息过长（上限 ${MAX_TEXT} 字）`)
    const res = await this._deliver(target.kind, target.id, msg, botId)
    await this._record({
      action: 'send',
      kind: target.kind,
      id: target.id,
      name: target.name,
      text: msg,
      replies: [],
      delivered: true,
    })
    return {sent: true, kind: target.kind, id: target.id, name: target.name, messageId: this._idOf(res) }
  }

  /**
   * 模拟执行一条指令
   * @param kind     group / private
   * @param id       群号 / QQ号
   * @param cmd      指令文本（# 开头）
   * @param deliver  是否把回复真的发到目标会话（false = 仅预览）
   * @param asOwner  是否以群主身份执行（群管指令需要）
   * @param confirm  危险指令放行标记
   */
  async exec({kind = 'group', id, cmd, deliver = false, asOwner = true, confirm = false, timeout = 6000} = {}) {
    this._throttle()

    const target = this._checkTarget(kind, id)
    const text = String(cmd ?? '').trim()
    if (!text) throw new Error('指令不能为空')
    if (text.length > 500) throw new Error('指令过长（上限 500 字）')
    if (DANGEROUS_RE.test(text) && !confirm)
      throw new Error('该指令可能影响 Bot 运行，需二次确认后执行')

    const bot = this.bot
    const selfId = this._realSelfId()
    if (!selfId) throw new Error('Bot 未就绪，请确认已登录')
    await this._getYzCfg()
    const master = this._masterQQ(selfId) || selfId

    const replies = []
    let finish
    const done = new Promise((r) => (finish = r))
    let settle = null

    const capture = async (msg) => {
      const t = segToText(msg).slice(0, MAX_TEXT)
      if (t) replies.push(t)
      if (deliver) {
        try {
          await this._deliver(target.kind, target.id, msg)
        } catch (e) {
          replies.push(`[发送失败] ${e.message}`)
        }
      }
      if (replies.length >= MAX_REPLIES) return finish()
      clearTimeout(settle)
      settle = setTimeout(finish, 600)
      return true
    }

    const data = this._buildEvent({
      kind: target.kind,
      id: target.id,
      name: target.name,
      selfId,
      userId: master,
      text,
      asOwner,
      reply: capture,
    })

    const started = Date.now()
    try {
      bot.em('message', data)
    } catch (e) {
      throw new Error(`事件注入失败：${e.message}`)
    }

    await Promise.race([done, sleep(Math.max(1000, Math.min(60000, Number(timeout) || 15000)))])
    clearTimeout(settle)

    const result = {
      kind: target.kind,
      id: target.id,
      name: target.name,
      cmd: text,
      delivered: !!deliver,
      replies,
      elapsed: Date.now() - started,
    }
    await this._record({action: 'exec', ...result})
    return result
  }

  /** 最近的执行/发送记录 */
  async history(limit = 30) {
    const n = Math.min(HISTORY_MAX, Math.max(1, Number(limit) || 30))
    try {
      if (this.redis) {
        const rows = await this.redis.lRange(HISTORY_KEY, 0, n - 1)
        return (rows || []).map((i) => this._parse(i)).filter(Boolean)
      }
    } catch {}
    return []
  }

  // ---------------------------------------------------------------- 内部

  _throttle() {
    const now = Date.now()
    this._hits = this._hits.filter((t) => now - t < 60000)
    if (this._hits.length >= 20) throw new Error('操作过于频繁（60 秒内最多 20 次）')
    this._hits.push(now)
  }

  /** 内核配置（cfg 是内核模块私有导入，这里按 cwd 动态加载） */
  _yzCfg = null
  async _getYzCfg() {
    if (this._yzCfg) return this._yzCfg
    try {
      const mod = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'config', 'config.js')).href)
      this._yzCfg = mod.default
    } catch {}
    return this._yzCfg
  }

  _masterQQ(selfId = '') {
    // 同步场景取缓存；exec 前会先 await 预热
    try {
      const master = this._yzCfg?.master ?? globalThis.cfg?.master ?? {}
      const list = master[selfId] ?? Object.values(master).flat()
      return String((list || [])[0] ?? '')
    } catch {
      return ''
    }
  }

  _checkTarget(kind, id) {
    const k = kind === 'private' || kind === 'friend' ? 'private' : 'group'
    const gid = String(id ?? '').trim()
    if (!gid || gid === 'stdin') throw new Error(k === 'group' ? '请选择群' : '请选择好友')
    if (!/^[\w@.\-]{4,64}$/.test(gid.replace(/^group-/, ''))) throw new Error('目标 ID 不合法')
    const norm = gid.replace(/^group-/, '')
    let name = ''
    try {
      const map = k === 'group' ? this.bot?.gl : this.bot?.fl
      const item = map?.get?.(Number(norm)) ?? map?.get?.(norm)
      name = String(item?.group_name || item?.name || item?.nickname || '')
    } catch {}
    return {kind: k, id: norm, name}
  }

  async _deliver(kind, id, msg, botId) {
    const bot = this.bot
    if (!bot) throw new Error('Bot 未就绪')
    const pick = (type) => {
      if (botId && bot.bots?.[botId]) {
        return type === 'group' ? bot.bots[botId].pickGroup(id) : bot.bots[botId].pickFriend(id)
      }
      return type === 'group' ? bot.pickGroup(id) : bot.pickFriend(id)
    }
    return pick(kind).sendMsg(msg)
  }

  _idOf(res) {
    return String(res?.message_id ?? res?.messageId ?? res?.data?.message_id ?? '')
  }

  /** 构造一条尽可能真实的伪事件 */
  _buildEvent({kind, id, name, selfId, userId, text, asOwner, reply}) {
    const groupShim = {
      group_id: kind === 'group' ? id : undefined,
      group_name: name,
      name,
      sendMsg: (msg) => this._deliver('group', id, msg),
      recallMsg: async () => true,
      getMsg: async () => null,
      pickMember: () => ({user_id: userId, nickname: '控制台', card: '控制台'}),
      getInfo: () => ({group_id: id, group_name: name}),
    }
    const friendShim = {
      user_id: kind === 'private' ? id : undefined,
      nickname: name,
      name,
      sendMsg: (msg) => this._deliver('private', id, msg),
      recallMsg: async () => true,
      getMsg: async () => null,
      getInfo: () => ({user_id: id, nickname: name}),
    }

    const data = {
      post_type: 'message',
      message_type: kind === 'group' ? 'group' : 'private',
      self_id: selfId,
      user_id: userId,
      message_id: `console-${Date.now()}`,
      raw_message: text,
      // at 段是必须的：没有它 onlyReplyAt 会返回 false，所有 rule 直接被跳过
      message: [
        {type: 'text', text},
        {type: 'at', qq: selfId},
      ],
      sender: {user_id: userId, nickname: '控制台', card: '控制台', role: asOwner ? 'owner' : 'member'},
      reply,
    }

    if (kind === 'group') {
      data.group_id = id
      data.group_name = name
      data.group = groupShim
      data.member = {
        user_id: userId,
        nickname: '控制台',
        card: '控制台',
        is_owner: !!asOwner,
        is_admin: !!asOwner,
        role: asOwner ? 'owner' : 'member',
      }
    } else {
      data.friend = friendShim
    }
    return data
  }

  _parse(raw) {
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      return null
    }
  }

  async _record(entry) {
    const row = {...entry, at: new Date().toISOString()}
    try {
      this.dbService?.writeAudit?.({
        actor: 'console',
        action: `console.${row.action}`,
        target: `${row.kind}:${row.id}`,
        detail: {
          cmd: row.cmd,
          text: row.text,
          delivered: row.delivered,
          replies: (row.replies || []).slice(0, 3),
        },
        ip: '',
      })
    } catch {}
    try {
      if (this.redis) {
        await this.redis.lPush(HISTORY_KEY, JSON.stringify(row))
        await this.redis.lTrim(HISTORY_KEY, 0, HISTORY_MAX - 1)
      }
    } catch {}
  }
}

export default ConsoleService
