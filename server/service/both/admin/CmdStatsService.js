import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)

/**
 * 指令使用统计 —— 解析 Yunzai 运行日志 logs/command.YYYY-MM-DD.log
 *
 * 用户指令行格式（TRSS-Yunzai）：
 *   [HH:MM:SS.mmm][MARK][群名(gid), 昵称(wxid)][指令名][[插件名]描述(目录)][完成N]
 * 定时任务行第 3 段是「任务名(cron)」，没有 ", " 分隔，据此排除。
 *
 * 历史文件 .gz 用 zlib 解；.zst 用 fzstd 解（纯 JS，免原生依赖）。
 * 日志行带 ANSI 颜色码且为 CRLF，读取后由 _clean() 整体清洗一次再逐行解析。
 * 统计维度：指令排行 / 群排行 / 用户排行 / 插件排行。结果缓存 5 分钟。
 */
export class CmdStatsService extends Service {

  constructor(app) {
    super(app)
    this._logDir = path.resolve(_paths.pluginRoot, '../../logs')
    this._cache = null
    this._cacheAt = 0
    this._cacheKey = ''
  }

  /**
   * 统计最近 days 天（1~30）。某天三种格式都不存在才计入 skippedDays。
   */
  async list({days = 7} = {}) {
    const n = Math.min(30, Math.max(1, Number(days) || 7))
    const cacheKey = `d${n}`
    if (this._cache && this._cacheKey === cacheKey && Date.now() - this._cacheAt < 300000) {
      return this._cache
    }

    const dayList = this._lastDays(n)
    const cmds = new Map() // 指令名 -> 次数
    const groups = new Map() // gid -> {name, count}
    const users = new Map() // wxid -> {nick, count}
    const plugins = new Map() // 插件目录 -> 次数
    let total = 0
    let skippedDays = []
    let parsedDays = []

    for (const day of dayList) {
      const raw = this._readDay(day)
      if (raw === null) {
        skippedDays.push(day)
        continue
      }
      // 一次性清洗：剥离 ANSI 颜色转义码与 CRLF 的 \r。
      // TRSS-Yunzai 的日志行是「[MARK] + ANSI + [群名(...), 昵称(...)]」，
      // 中间的 ESC 序列会让行首锚定正则整行失配，必须先整体清掉再逐行解析。
      const text = this._clean(raw)
      parsedDays.push(day)
      for (const line of text.split('\n')) {
        const r = this._parseLine(line)
        if (!r) continue
        total++
        cmds.set(r.cmd, (cmds.get(r.cmd) || 0) + 1)
        const g = groups.get(r.gid) || {gid: r.gid, name: r.gname, count: 0}
        g.count++
        if (!g.name && r.gname) g.name = r.gname
        groups.set(r.gid, g)
        const u = users.get(r.uid) || {uid: r.uid, nick: r.nick, count: 0}
        u.count++
        if (!u.nick && r.nick) u.nick = r.nick
        users.set(r.uid, u)
        if (r.plugin) plugins.set(r.plugin, (plugins.get(r.plugin) || 0) + 1)
      }
    }

    const result = {
      days: n,
      parsedDays,
      skippedDays,
      total,
      cmds: this._top(cmds).map(([name, count]) => ({name, count})),
      groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 15),
      users: [...users.values()].sort((a, b) => b.count - a.count).slice(0, 15),
      plugins: this._top(plugins).map(([name, count]) => ({name, count})),
    }
    this._cache = result
    this._cacheAt = Date.now()
    this._cacheKey = cacheKey
    return result
  }

  _lastDays(n) {
    const out = []
    const now = new Date()
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getTime() - i * 86400000)
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
    return out
  }

  /** 读某天的 command 日志：明文 / gz / zst（fzstd 解压）；都不存在返回 null */
  _readDay(day) {
    const base = path.join(this._logDir, `command.${day}.log`)
    try {
      if (fs.existsSync(base)) return fs.readFileSync(base, 'utf8')
      if (fs.existsSync(base + '.gz')) return zlib.gunzipSync(fs.readFileSync(base + '.gz')).toString('utf8')
      if (fs.existsSync(base + '.zst')) return this._unzstd(fs.readFileSync(base + '.zst'))
    } catch {
      return null
    }
    return null
  }

  /**
   * 清洗一整天的日志文本（整文件只做一次，避免 5000+ 行逐行跑正则）：
   *  1. 剥离 ANSI CSI 转义序列（颜色码 \x1b[34m / 复位 \x1b[39m 等）
   *  2. 去掉 CRLF 里的 \r
   * @param {string} text 原始日志文本
   * @returns {string} 清洗后的文本
   */
  _clean(text) {
    if (typeof text !== 'string' || text.length === 0) return ''
    return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
  }

  /** fzstd 纯 JS 解压（TRSS-Yunzai 的 zst 日志是原始 zstd 帧流） */
  _unzstd(buf) {
    try {
      const fzstd = require('fzstd')
      const out = fzstd.decompress(buf)
      return Buffer.from(out).toString('utf8')
    } catch {
      return null
    }
  }

  /**
   * 解析一行。只认「用户指令」，定时任务/系统行返回 null。
   * 用行首锚定正则取 target/cmd，行尾锚定取插件目录；不能用 split('][')，
   * 因为插件描述里本身含 ']['（如 [[Genshin/Game.js]xxx(lots)]）。
   */
  _parseLine(line) {
    if (!line || line[0] !== '[') return null
    const head = line.match(/^\[[\d:.\s]*\]\[(?:INFO|MARK|WARN|ERRO)\]\[([^\]]+)\]\[([^\]]+)\]/)
    if (!head) return null
    const target = head[1]
    const cmd = head[2].trim()
    if (!target.includes(', ')) return null
    const tm = target.match(/^(.*)\(([^()]*)\), (.*)\(([^()]*)\)$/)
    if (!tm) return null
    const gname = tm[1]
    const gid = String(tm[2]).replace('@chatroom', '')
    const nick = tm[3]
    const uid = tm[4]
    if (!cmd || !gid) return null
    // 插件目录：行尾锚定「(目录)][完成N]」；「完成」是中文，不能用 \w
    let plugin = ''
    const pm = line.match(/\(([^()]+)\)\]\[[^\[\]]+\]\s*$/)
    if (pm) plugin = pm[1]
    return {gname, gid, nick, uid, cmd, plugin}
  }

  _top(map, n = 20) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  }
}

export default CmdStatsService
