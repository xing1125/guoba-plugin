import fs from 'node:fs'
import path from 'node:path'
import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 工作区文件管理服务
 *
 * 在浏览器后台直接浏览 / 编辑云崽的配置与插件文件，替代逐个开文件夹：
 *   - root=config  → app/config        （Bot / 机器人 / 各核心配置 yaml）
 *   - root=plugins → app/plugins       （全部插件的源码 / 配置 / 数据）
 *
 * 安全约束：
 *   - 只允许在两个白名单根目录内活动（realpath 防 ../ 逃逸）
 *   - 目录黑名单（node_modules / .git 等）不可进入
 *   - 只读/可写均为文本扩展名白名单，单文件读写有大小上限
 *   - 写入前自动备份 <file>.bak.<时间戳>；JSON / YAML 写入前做语法校验
 *   - 删除不直接删，而是移入 temp/guoba-trash 回收站
 *   - 全部写操作写审计日志
 */

/** 可读/可写的文本扩展名白名单 */
const EDIT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.vue', '.jsx', '.tsx',
  '.json', '.jsonl', '.ndjson',
  '.yaml', '.yml', '.txt', '.md', '.csv', '.log',
  '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.ini', '.conf', '.sh', '.bat', '.cmd', '.ps1',
])
/** 无扩展名但允许编辑的常见 dotfile */
const EDIT_NAME = new Set(['.gitignore', '.gitattributes', '.npmrc', '.browserslistrc'])
/** 不可进入的目录名 */
const BLACKLIST_DIR = new Set(['node_modules', '.git', '.svn', '.hg', '.pnpm'])

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_DEPTH = 12

export class WorkspaceService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    // _paths.pluginRoot = .../app/plugins/Guoba-Plugin → 上两级即 app/
    this.appRoot = path.resolve(_paths.pluginRoot, '..', '..')
    /** @type {Record<string, {label:string, dir:string}>} */
    this.rootsMap = {
      config: {label: 'Bot 配置 (app/config)', dir: path.join(this.appRoot, 'config')},
      plugins: {label: '插件 (app/plugins)', dir: path.join(this.appRoot, 'plugins')},
    }
    this.trashDir = path.join(this.appRoot, 'temp', 'guoba-trash')
  }

  /** 根目录清单 */
  roots() {
    return Object.entries(this.rootsMap).map(([key, r]) => ({
      key,
      label: r.label,
      rel: path.relative(this.appRoot, r.dir).replace(/\\/g, '/'),
    }))
  }

  /* ----------------------------- 路径安全 ----------------------------- */

  /** 编辑能力判定：扩展名白名单（或 dotfile）+ 大小上限 */
  _editable(name, size) {
    const ext = path.extname(name).toLowerCase()
    const ok = EDIT_EXT.has(ext) || (name.startsWith('.') && !ext && EDIT_NAME.has(name.toLowerCase()))
    return ok && size <= MAX_WRITE_BYTES
  }

  /** 是否黑名单目录 */
  _blocked(name) {
    return BLACKLIST_DIR.has(name.toLowerCase())
  }

  /** 相对路径归一 + 分段校验（拒 ..、拒黑名单目录段） */
  _normalize(relPath) {
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!rel) {
      return ''
    }
    if (rel.length > 1000) {
      throw new Error('路径过长')
    }
    const segs = rel.split('/')
    if (segs.length > MAX_DEPTH) {
      throw new Error('路径层级过深')
    }
    for (const seg of segs) {
      if (!seg || seg === '.' || seg === '..') {
        throw new Error('路径不合法')
      }
      if (this._blocked(seg)) {
        throw new Error(`不允许访问 ${seg} 目录`)
      }
    }
    return segs.join('/')
  }

  /** 把 root + 相对路径安全解析为绝对路径（realpath 防逃逸） */
  _safePath(rootKey, relPath) {
    const root = this.rootsMap[String(rootKey || '')]
    if (!root) {
      throw new Error('未知的工作区，只允许 config / plugins')
    }
    if (!fs.existsSync(root.dir)) {
      throw new Error(`工作区目录不存在：${root.dir}`)
    }
    const rel = this._normalize(relPath)
    const target = path.resolve(root.dir, rel)
    const realRoot = fs.realpathSync(root.dir)
    const realTarget = fs.existsSync(target) ? fs.realpathSync(target) : target
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error('路径越界，拒绝访问')
    }
    return {root, rel, target}
  }

  /* ----------------------------- 浏览 ----------------------------- */

  /** 列目录 */
  list(rootKey, relPath = '') {
    const {root, rel, target} = this._safePath(rootKey, relPath)
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error('目录不存在')
    }
    if (!stat.isDirectory()) {
      throw new Error('不是目录')
    }
    const baseRel = rel
    const items = []
    let entries = []
    try {
      entries = fs.readdirSync(target, {withFileTypes: true})
    } catch (e) {
      throw new Error(`读取目录失败：${e.message}`)
    }
    for (const e of entries) {
      if (this._blocked(e.name)) {
        continue
      }
      const full = path.join(target, e.name)
      const childRel = baseRel ? `${baseRel}/${e.name}` : e.name
      if (e.isDirectory()) {
        let childCount = 0
        try {
          childCount = fs.readdirSync(full).filter((n) => !this._blocked(n)).length
        } catch {}
        items.push({name: e.name, path: childRel, dir: true, size: 0, mtime: null, ext: '', editable: false, childCount})
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      const editableName = EDIT_EXT.has(ext) || (e.name.startsWith('.') && !ext && EDIT_NAME.has(e.name.toLowerCase()))
      if (!editableName) {
        continue
      }
      let st = null
      try {
        st = fs.statSync(full)
      } catch {}
      const size = st?.size ?? 0
      items.push({
        name: e.name,
        path: childRel,
        dir: false,
        size,
        mtime: st ? new Date(st.mtimeMs).toISOString() : null,
        ext,
        editable: this._editable(e.name, size),
      })
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.dir ? -1 : 1))
    return {root: String(rootKey), label: root.label, path: baseRel, list: items}
  }

  /* ----------------------------- 读写 ----------------------------- */

  /** 读文件内容 */
  read(rootKey, relPath) {
    const {target, rel} = this._safePath(rootKey, relPath)
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error('文件不存在')
    }
    if (stat.isDirectory()) {
      throw new Error('这是一个目录')
    }
    if (!this._editable(path.basename(target), stat.size)) {
      throw new Error('该类型或大小的文件不支持在线查看/编辑')
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB，拒绝在线编辑`)
    }
    return {
      root: String(rootKey),
      path: rel,
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      ext: path.extname(target).toLowerCase(),
      content: fs.readFileSync(target, 'utf8'),
      backups: this._countBackups(target),
    }
  }

  /** 校验文本内容（json / jsonl / yaml） */
  async _validate(ext, text) {
    if (ext === '.json') {
      try {
        JSON.parse(text)
      } catch (e) {
        throw new Error(`JSON 格式不合法：${e.message}`)
      }
    } else if (ext === '.jsonl' || ext === '.ndjson') {
      const lines = text.split(/\r?\n/).filter((l) => l.trim())
      for (let i = 0; i < lines.length; i++) {
        try {
          JSON.parse(lines[i])
        } catch (e) {
          throw new Error(`第 ${i + 1} 行不是合法 JSON：${e.message}`)
        }
      }
    } else if (ext === '.yaml' || ext === '.yml') {
      try {
        const mod = await import('yaml')
        const YAML = mod.default || mod
        YAML.parse(text)
      } catch (e) {
        throw new Error(`YAML 格式不合法：${e.message}`)
      }
    }
  }

  /** 内部写入（含备份 + 校验 + 审计） */
  async _write(rootKey, rel, target, text, ctx, action) {
    const ext = path.extname(target).toLowerCase()
    const name = path.basename(target)
    if (!(EDIT_EXT.has(ext) || (name.startsWith('.') && !ext && EDIT_NAME.has(name.toLowerCase())))) {
      throw new Error('该类型文件不允许编辑')
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) {
      throw new Error(`内容超过 ${MAX_WRITE_BYTES / 1024}KB，拒绝写入`)
    }
    await this._validate(ext, text)
    let backup = null
    if (fs.existsSync(target)) {
      backup = `${target}.bak.${Date.now()}`
      fs.copyFileSync(target, backup)
    }
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, text, 'utf8')
    this.dbService.writeAudit({
      ...ctx,
      action,
      target: `${rootKey}/${rel}`,
      detail: {bytes: Buffer.byteLength(text, 'utf8'), backup: backup ? path.basename(backup) : null},
    })
    return {root: rootKey, path: rel, bytes: Buffer.byteLength(text, 'utf8'), backup: backup ? path.basename(backup) : null}
  }

  /** 保存已有文件 */
  async write(rootKey, relPath, content, ctx = {}) {
    const {rel, target} = this._safePath(rootKey, relPath)
    if (!fs.existsSync(target)) {
      throw new Error('文件不存在，请用「新建文件」')
    }
    if (fs.statSync(target).isDirectory()) {
      throw new Error('这是一个目录')
    }
    return this._write(rootKey, rel, target, String(content ?? ''), ctx, 'workspace.write')
  }

  /** 校验单段名称（新建/重命名用） */
  _checkName(name) {
    const n = String(name || '').trim()
    if (!n || n === '.' || n === '..' || /[\\/:*?"<>|]/.test(n)) {
      throw new Error(`名称不合法：${name}`)
    }
    if (n.length > 120) {
      throw new Error('名称过长')
    }
    return n
  }

  /** 新建文件 / 目录 */
  async create(rootKey, parentRel, name, isDir = false, content = '', ctx = {}) {
    const {rel: parent, target: parentDir} = this._safePath(rootKey, parentRel)
    const n = this._checkName(name)
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      throw new Error('父目录不存在')
    }
    const target = path.join(parentDir, n)
    if (fs.existsSync(target)) {
      throw new Error(`${n} 已存在`)
    }
    const childRel = parent ? `${parent}/${n}` : n
    if (isDir) {
      fs.mkdirSync(target, {recursive: true})
      this.dbService.writeAudit({...ctx, action: 'workspace.mkdir', target: `${rootKey}/${childRel}`, detail: {}})
      return {root: rootKey, path: childRel, dir: true}
    }
    return this._write(rootKey, childRel, target, String(content ?? ''), ctx, 'workspace.create')
  }

  /** 删除（移入回收站，不直接删） */
  async remove(rootKey, relPath, ctx = {}) {
    const {rel, target} = this._safePath(rootKey, relPath)
    if (!rel) {
      throw new Error('不能删除工作区根目录')
    }
    if (!fs.existsSync(target)) {
      throw new Error('目标不存在')
    }
    fs.mkdirSync(this.trashDir, {recursive: true})
    const trashName = `${Date.now()}_${path.basename(target)}`
    const dest = path.join(this.trashDir, trashName)
    fs.renameSync(target, dest)
    this.dbService.writeAudit({
      ...ctx,
      action: 'workspace.remove',
      target: `${rootKey}/${rel}`,
      detail: {trash: `temp/guoba-trash/${trashName}`},
    })
    return {root: rootKey, path: rel, trash: `temp/guoba-trash/${trashName}`}
  }

  /** 重命名 / 移动到同目录新名字 */
  async rename(rootKey, relPath, newName, ctx = {}) {
    const {rel, target} = this._safePath(rootKey, relPath)
    if (!rel) {
      throw new Error('不能重命名工作区根目录')
    }
    if (!fs.existsSync(target)) {
      throw new Error('目标不存在')
    }
    const n = this._checkName(newName)
    const dest = path.join(path.dirname(target), n)
    if (fs.existsSync(dest)) {
      throw new Error(`${n} 已存在`)
    }
    fs.renameSync(target, dest)
    const parentRel = path.dirname(rel).replace(/\\/g, '/')
    const childRel = parentRel === '.' ? n : `${parentRel}/${n}`
    this.dbService.writeAudit({
      ...ctx,
      action: 'workspace.rename',
      target: `${rootKey}/${rel}`,
      detail: {to: childRel},
    })
    return {root: rootKey, path: rel, to: childRel}
  }

  /* ----------------------------- 备份 ----------------------------- */

  _countBackups(full) {
    try {
      const dir = path.dirname(full)
      const base = path.basename(full) + '.bak.'
      return fs.readdirSync(dir).filter((n) => n.startsWith(base)).length
    } catch {
      return 0
    }
  }

  /** 备份列表 */
  backups(rootKey, relPath) {
    const {target} = this._safePath(rootKey, relPath)
    const dir = path.dirname(target)
    const base = path.basename(target) + '.bak.'
    const out = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(base)) {
        continue
      }
      const ts = Number(name.slice(base.length))
      let size = 0
      try {
        size = fs.statSync(path.join(dir, name)).size
      } catch {}
      out.push({name, ts, time: Number.isFinite(ts) ? new Date(ts).toISOString() : null, size})
    }
    return out.sort((a, b) => b.ts - a.ts)
  }

  /** 从备份恢复（恢复前会把当前内容再备份一次） */
  async restoreBackup(rootKey, relPath, backupName, ctx = {}) {
    const {rel, target} = this._safePath(rootKey, relPath)
    const dir = path.dirname(target)
    if (!String(backupName).startsWith(path.basename(target) + '.bak.')) {
      throw new Error('备份文件名不合法')
    }
    const src = path.join(dir, backupName)
    if (!fs.existsSync(src)) {
      throw new Error('备份不存在')
    }
    fs.copyFileSync(target, `${target}.bak.${Date.now()}`)
    fs.copyFileSync(src, target)
    this.dbService.writeAudit({
      ...ctx,
      action: 'workspace.restore',
      target: `${rootKey}/${rel}`,
      detail: {backup: backupName},
    })
    return {root: rootKey, path: rel, restored: true}
  }
}
