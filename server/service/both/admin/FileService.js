import fs from 'node:fs'
import path from 'node:path'
import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * 插件数据文件服务
 *
 * 各插件把自己的运行数据写在 `app/plugins/<插件>/data/` 下（json / jsonl / yaml / txt）。
 * 后台提供浏览与编辑能力，用于「非 Redis」那部分数据的可控可改。
 *
 * 安全约束：
 *   - 只能访问 `plugins/<已安装插件>/data` 目录内的文件
 *   - 扩展名白名单 + 单文件大小上限
 *   - 路径必须 resolve 在允许目录内（防 ../ 逃逸）
 *   - 写入前备份为 `<file>.bak.<时间戳>`
 */

const ALLOW_EXT = new Set(['.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.txt', '.csv', '.log', '.md'])
const MAX_FILE_BYTES = 1024 * 1024
const MAX_DEPTH = 4

export class FileService extends Service {

  dbService = autowired('dbService')

  constructor(app) {
    super(app)
    const pr = _paths.pluginRoot
    this.pluginsRoot = pr ? path.dirname(pr) : path.resolve(_paths.data || '.', '..', 'plugins')
  }

  _pluginsDir() {
    // _paths.pluginRoot 指向 Guoba-Plugin 本身；其父目录即 plugins 根
    const root = this.pluginsRoot
    if (!root || !fs.existsSync(root)) {
      throw new Error('找不到插件目录')
    }
    return root
  }

  /** 列表：哪些插件有 data 目录，各有多少文件、多大 */
  listPlugins() {
    const root = this._pluginsDir()
    const out = []
    for (const name of fs.readdirSync(root)) {
      const dataDir = path.join(root, name, 'data')
      let stat
      try {
        stat = fs.statSync(dataDir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) {
        continue
      }
      let files = 0
      let bytes = 0
      const walk = (dir, depth) => {
        if (depth > MAX_DEPTH) {
          return
        }
        let entries = []
        try {
          entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
          return
        }
        for (const e of entries) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) {
            walk(full, depth + 1)
          } else if (ALLOW_EXT.has(path.extname(e.name).toLowerCase())) {
            files += 1
            try {
              bytes += fs.statSync(full).size
            } catch {}
          }
        }
      }
      walk(dataDir, 0)
      if (files > 0) {
        out.push({plugin: name, files, bytes})
      }
    }
    return out.sort((a, b) => b.files - a.files)
  }

  /** 把相对路径安全解析为绝对路径 */
  _safePath(plugin, relPath = '') {
    if (!plugin || /[\\/]/.test(plugin) || plugin.includes('..')) {
      throw new Error('插件名不合法')
    }
    const root = this._pluginsDir()
    const dataDir = path.join(root, plugin, 'data')
    const realRoot = fs.existsSync(dataDir) ? fs.realpathSync(dataDir) : dataDir
    const target = path.resolve(dataDir, relPath || '.')
    const realTarget = fs.existsSync(target) ? fs.realpathSync(target) : target
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error('路径越界，拒绝访问')
    }
    return realTarget
  }

  /** 列目录（相对 data 的路径） */
  listFiles(plugin, relPath = '') {
    const dir = this._safePath(plugin, relPath)
    const stat = fs.statSync(dir)
    if (!stat.isDirectory()) {
      throw new Error('不是目录')
    }
    const items = []
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, e.name)
      const rel = path.relative(path.join(this._pluginsDir(), plugin, 'data'), full).replace(/\\/g, '/')
      if (e.isDirectory()) {
        let childCount = 0
        try {
          childCount = fs.readdirSync(full).length
        } catch {}
        items.push({name: e.name, path: rel, dir: true, size: 0, mtime: null, childCount})
      } else {
        const ext = path.extname(e.name).toLowerCase()
        if (!ALLOW_EXT.has(ext)) {
          continue
        }
        let st = null
        try {
          st = fs.statSync(full)
        } catch {}
        items.push({
          name: e.name,
          path: rel,
          dir: false,
          size: st?.size ?? 0,
          mtime: st ? new Date(st.mtimeMs).toISOString() : null,
          ext,
          editable: (st?.size ?? 0) <= MAX_FILE_BYTES,
          backupCount: this._countBackups(full),
        })
      }
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    return {plugin, path: relPath, list: items}
  }

  _countBackups(full) {
    try {
      const dir = path.dirname(full)
      const base = path.basename(full) + '.bak.'
      return fs.readdirSync(dir).filter((n) => n.startsWith(base)).length
    } catch {
      return 0
    }
  }

  /** 读文件内容 */
  readFile(plugin, relPath) {
    const full = this._safePath(plugin, relPath)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      throw new Error('这是一个目录')
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024}KB，拒绝在线编辑`)
    }
    const ext = path.extname(full).toLowerCase()
    const content = fs.readFileSync(full, 'utf8')
    return {
      plugin,
      path: relPath.replace(/\\/g, '/'),
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      ext,
      content,
      backups: this._countBackups(full),
    }
  }

  /** 写文件（先备份） */
  writeFile(plugin, relPath, content, ctx = {}) {
    const full = this._safePath(plugin, relPath)
    if (!fs.existsSync(full)) {
      throw new Error('文件不存在，暂不支持新建')
    }
    const ext = path.extname(full).toLowerCase()
    if (!ALLOW_EXT.has(ext)) {
      throw new Error('该类型文件不允许编辑')
    }
    const text = String(content ?? '')
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('内容超过 1MB，拒绝写入')
    }
    // JSON / JSONL 做一次语法校验，避免写坏插件数据
    if (ext === '.json') {
      try {
        JSON.parse(text)
      } catch (e) {
        throw new Error(`JSON 格式不合法：${e.message}`)
      }
    } else if (ext === '.jsonl' || ext === '.ndjson') {
      const lines = text.split(/\r?\n/).filter(Boolean)
      for (let i = 0; i < lines.length; i++) {
        try {
          JSON.parse(lines[i])
        } catch (e) {
          throw new Error(`第 ${i + 1} 行不是合法 JSON：${e.message}`)
        }
      }
    }

    const backup = `${full}.bak.${Date.now()}`
    fs.copyFileSync(full, backup)
    fs.writeFileSync(full, text, 'utf8')

    this.dbService.writeAudit({
      ...ctx,
      action: 'file.write',
      target: `${plugin}/${relPath}`,
      detail: {bytes: Buffer.byteLength(text, 'utf8'), backup: path.basename(backup)},
    })
    return {plugin, path: relPath, bytes: Buffer.byteLength(text, 'utf8'), backup: path.basename(backup)}
  }

  /** 备份列表 */
  listBackups(plugin, relPath) {
    const full = this._safePath(plugin, relPath)
    const dir = path.dirname(full)
    const base = path.basename(full) + '.bak.'
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

  /** 从备份恢复 */
  restoreBackup(plugin, relPath, backupName, ctx = {}) {
    const full = this._safePath(plugin, relPath)
    const dir = path.dirname(full)
    if (!String(backupName).startsWith(path.basename(full) + '.bak.')) {
      throw new Error('备份文件名不合法')
    }
    const src = path.join(dir, backupName)
    if (!fs.existsSync(src)) {
      throw new Error('备份不存在')
    }
    fs.copyFileSync(full, `${full}.bak.${Date.now()}`)
    fs.copyFileSync(src, full)
    this.dbService.writeAudit({
      ...ctx,
      action: 'file.restore',
      target: `${plugin}/${relPath}`,
      detail: {backup: backupName},
    })
    return {plugin, path: relPath, restored: true}
  }
}
