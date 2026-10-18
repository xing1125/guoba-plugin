import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 运行日志中心服务
 *
 * 数据源：`<Yunzai>/app/logs`
 *   - `command.YYYY-MM-DD.log`  按天切分的命令/请求流水（TRSS 默认）
 *   - `error.log`               错误堆栈（不分天，持续追加）
 *   - 历史文件可能被 gzip 成 `*.log.gz`
 *
 * 行格式（Yunzai logger）：
 *   `[05:23:16.199][ERRO][AI荧2(...), 岑曜(wxid_xxx)][#ds心理][YingAI(showMindFor)] ReferenceError: ...`
 *   即 `[时间][级别][上下文…] 正文`，随后是续行（缩进的堆栈）。
 *
 * 设计要点：
 *   - 只读为主：读窗口固定 1.5MB（大文件从尾部读，不整文件加载）
 *   - 续行（不以时间戳开头的行）合并进上一条 entry 的 detail，堆栈不会被拆散
 *   - 级别归一：ERRO→ERROR / WARN→WARN / MARK / INFO / DEBU→DEBUG / TRAC→TRACE
 *   - 清空是唯一写操作：只允许 `.log`（拒 gz），必须 confirm，落审计
 */

/** 读窗口上限：每次只从尾部读这么多字节 */
const MAX_WINDOW = 1.5 * 1024 * 1024
/** 单条 entry 保留的续行上限（堆栈够看就行，防止内存膨胀） */
const MAX_DETAIL_LINES = 60
/** 下载上限 */
const MAX_DOWNLOAD = 8 * 1024 * 1024
/** 允许的文件名：logs 目录下的 .log / .log.gz */
const FILE_RE = /^[^\\/:*?"<>|]+\.log(\.gz)?$/i

const LEVEL_ALIAS = {
  ERRO: 'ERROR',
  ERROR: 'ERROR',
  WARN: 'WARN',
  WARNING: 'WARN',
  INFO: 'INFO',
  MARK: 'MARK',
  DEBU: 'DEBUG',
  DEBUG: 'DEBUG',
  TRAC: 'TRACE',
  TRACE: 'TRACE',
  FATA: 'FATAL',
  FATAL: 'FATAL',
}

/** ANSI 颜色/光标控制序列（日志文件里带 \u001b[33m 这类，直接展示会变成 [33m） */
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><])/g

function stripAnsi(s) {
  return s.replace(ANSI_RE, '')
}

/** 行首解析：[05:23:16.199][ERRO][ctx][ctx2] 正文 */
const LINE_RE = /^\[(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\[([A-Za-z]{3,6})\](.*)$/

function normLevel(raw) {
  const k = String(raw || '').toUpperCase()
  return LEVEL_ALIAS[k] || k || 'INFO'
}

export class LogService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    // _paths.pluginRoot = .../app/plugins/Guoba-Plugin → 上两级即 app/
    this.appRoot = path.resolve(_paths.pluginRoot, '..', '..')
    this.logDir = path.join(this.appRoot, 'logs')
  }

  /* ------------------------------------------------------------ 文件清单 */

  /** @returns {{dir:string, files:any[], totalSize:number, today:string}} */
  listFiles() {
    const dir = this.logDir
    const today = this._today()
    if (!fs.existsSync(dir)) {
      return {dir, files: [], totalSize: 0, today, available: false}
    }
    const names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n))
    const files = []
    for (const name of names) {
      const abs = path.join(dir, name)
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (!st.isFile()) {
        continue
      }
      files.push(this._describe(name, st))
    }
    // 排序：error.log 置顶 → 今天的 command → 其余按日期倒序
    files.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1
      }
      if (a.date !== b.date) {
        return String(b.date).localeCompare(String(a.date))
      }
      return String(b.mtime).localeCompare(String(a.mtime))
    })
    const totalSize = files.reduce((s, f) => s + f.size, 0)
    return {dir, files, totalSize, today, available: true}
  }

  _describe(name, st) {
    const gz = /\.gz$/i.test(name)
    const base = gz ? name.slice(0, -3) : name
    const kind = /^error\./i.test(base) ? 'error' : /^command\./i.test(base) ? 'command' : 'other'
    const m = base.match(/(\d{4}-\d{2}-\d{2})/)
    return {
      file: name,
      kind,
      gz,
      pinned: kind === 'error',
      date: m ? m[1] : '',
      label: kind === 'error' ? '错误日志' : kind === 'command' ? `运行流水 ${m ? m[1] : ''}`.trim() : name,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      today: m ? m[1] === this._today() : false,
    }
  }

  _today() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  _resolve(file) {
    const name = String(file || '')
    if (!FILE_RE.test(name)) {
      throw new Error('非法的日志文件名')
    }
    const abs = path.join(this.logDir, name)
    if (!fs.existsSync(abs)) {
      throw new Error(`日志文件不存在：${name}`)
    }
    const st = fs.statSync(abs)
    if (!st.isFile()) {
      throw new Error('目标不是文件')
    }
    return {abs, st, name}
  }

  /* ------------------------------------------------------------ 读取 */

  /**
   * 读取日志尾部并解析
   * @param {{file:string, lines?:number, level?:string, q?:string}} opts
   */
  read(opts = {}) {
    const {abs, st, name} = this._resolve(opts.file)
    const limit = Math.min(Math.max(Number(opts.lines) || 300, 20), 3000)
    const level = String(opts.level || '').toUpperCase()
    const q = String(opts.q || '').trim()
    const gz = /\.gz$/i.test(name)

    const {prefix, text} = this._slice(abs, st, gz)
    const entries = this._parse(text, {name, gz, truncated: prefix > 0, cut: prefix})

    let list = entries
    if (level && level !== 'ALL') {
      list = list.filter((e) => e.level === level)
    }
    if (q) {
      const needle = q.toLowerCase()
      list = list.filter(
        (e) => e.raw.toLowerCase().includes(needle) || e.detail.join('\n').toLowerCase().includes(needle),
      )
    }
    const matched = list.length
    const tail = list.slice(-limit)
    return {
      file: name,
      gz,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      total: entries.length,
      matched,
      /** 是否因为窗口限制只看到了文件尾部 */
      windowed: prefix > 0,
      windowBytes: Math.min(st.size, MAX_WINDOW),
      limit,
      counts: this._countByLevel(entries),
      entries: tail,
    }
  }

  /** 从尾部取窗口，返回 {prefix, text} */
  _slice(abs, st, gz) {
    if (gz) {
      // 归档文件通常很小，整体解压
      const buf = fs.readFileSync(abs)
      const text = zlib.gunzipSync(buf).toString('utf8')
      return {prefix: 0, text}
    }
    const start = Math.max(0, st.size - MAX_WINDOW)
    const len = st.size - start
    if (len <= 0) {
      return {prefix: 0, text: ''}
    }
    const fd = fs.openSync(abs, 'r')
    try {
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, start)
      let text = buf.toString('utf8')
      // 从中间截断时，丢掉第一行残片
      if (start > 0) {
        const nl = text.indexOf('\n')
        text = nl >= 0 ? text.slice(nl + 1) : ''
      }
      return {prefix: start, text}
    } finally {
      fs.closeSync(fd)
    }
  }

  /** 解析成条目（续行并入上一条） */
  _parse(text, {name, gz, windowed}) {
    const lines = stripAnsi(text).split(/\r?\n/)
    const out = []
    let cur = null
    for (const line of lines) {
      if (!line) {
        continue
      }
      const m = LINE_RE.exec(line)
      if (m) {
        if (cur) {
          out.push(cur)
        }
        cur = {
          time: m[1],
          level: normLevel(m[2]),
          levelRaw: m[2].toUpperCase(),
          ctx: (m[3] || '').trim(),
          raw: line,
          detail: [],
        }
      } else if (cur) {
        if (cur.detail.length < MAX_DETAIL_LINES) {
          cur.detail.push(line)
        }
      } else {
        // 文件开头就是续行（极少见，通常是 error.log 被外部截断）
        cur = {time: '', level: 'INFO', levelRaw: '', ctx: '', raw: line, detail: []}
      }
    }
    if (cur) {
      out.push(cur)
    }
    for (const e of out) {
      e.file = name
      e.archive = !!gz
      e.msg = e.raw.replace(/^\[[^\]]*\]\[[^\]]*\](?:\[[^\]]*\])*/, '').trim()
    }
    if (windowed) {
      // 窗口内第一条可能是半条，丢掉
      out.shift()
    }
    return out
  }

  _countByLevel(entries) {
    const c = {ERROR: 0, WARN: 0, MARK: 0, INFO: 0, DEBUG: 0, TRACE: 0, FATAL: 0}
    for (const e of entries) {
      if (c[e.level] === undefined) {
        c[e.level] = 0
      }
      c[e.level]++
    }
    return c
  }

  /* ------------------------------------------------------------ 概要 */

  /** 首页/页头用的汇总：今日错误、最近一条错误、占用 */
  summary() {
    const {files, totalSize, available, dir} = this.listFiles()
    const out = {
      available,
      dir,
      fileCount: files.length,
      totalSize,
      todayErrors: 0,
      todayWarns: 0,
      todayMarks: 0,
      lastError: null,
      latestFile: files.find((f) => f.today && f.kind === 'command') || files[0] || null,
    }
    if (!available) {
      return out
    }
    // 今日流水：只解析窗口内的
    const todayFile = files.find((f) => f.today && f.kind === 'command')
    if (todayFile) {
      try {
        const r = this.read({file: todayFile.file, lines: 50})
        out.todayErrors = r.counts.ERROR || 0
        out.todayWarns = r.counts.WARN || 0
        out.todayMarks = r.counts.MARK || 0
      } catch {
        /* 忽略：摘要不该让页面挂掉 */
      }
    }
    // 最近一条错误（error.log 尾部）
    const errFile = files.find((f) => f.kind === 'error' && !f.gz)
    if (errFile) {
      try {
        const r = this.read({file: errFile.file, lines: 1})
        const last = r.entries[r.entries.length - 1]
        if (last) {
          out.lastError = {time: last.time, msg: last.msg.slice(0, 160), ctx: last.ctx, level: last.level}
        }
      } catch {
        /* ignore */
      }
    }
    return out
  }

  /* ------------------------------------------------------------ 下载 / 清空 */

  download(file) {
    const {abs, st, name} = this._resolve(file)
    if (st.size > MAX_DOWNLOAD) {
      throw new Error(`文件超过 ${Math.round(MAX_DOWNLOAD / 1024 / 1024)}MB，请改用筛选后复制`)
    }
    const buffer = fs.readFileSync(abs)
    return {name, size: st.size, buffer, gz: /\.gz$/i.test(name)}
  }

  /** 清空日志（唯一写操作） */
  clear(file, ctx = {}) {
    const {abs, st, name} = this._resolve(file)
    if (/\.gz$/i.test(name)) {
      throw new Error('归档日志（.gz）不支持清空，请直接删除文件')
    }
    const before = st.size
    fs.truncateSync(abs, 0)
    try {
      this.dbService.writeAudit({
        actor: ctx.actor || '',
        action: 'logs.clear',
        target: name,
        detail: {before},
        ip: ctx.ip || '',
      })
    } catch {
      /* 审计失败不影响主流程 */
    }
    return {file: name, clearedBytes: before}
  }
}
