import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import path from 'node:path'
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'

/**
 * 插件健康度服务
 *
 * 回答三个问题：
 *   1. 磁盘上的插件，哪些真的被 Yunzai 加载了？（loader.priority 的 key = 插件目录名）
 *   2. 每个插件有多少个插件类 / apps 文件？
 *   3. 每个插件占了多少磁盘（data/resources 等全部内容，排除 node_modules）？
 *
 * 「挂着但其实是死的」= 磁盘有 index.js / apps 但没出现在 loader.priority 里。
 */
export class PluginHealthService extends Service {

  constructor(app) {
    super(app)
    this._pluginsDir = path.resolve(_paths.pluginRoot, '..')
    this._yunzaiApp = path.resolve(_paths.pluginRoot, '../..')
    /** loader 单例缓存与已加载 key 集合缓存 */
    this._loader = null
    this._loadedKeys = null
    this._loadedAt = 0
    /** 目录大小缓存（字节），10 分钟 */
    this._sizeCache = new Map()
    this._sizeAt = new Map()
    /** 非插件目录（Yunzai 官方约定目录，不参与健康判定） */
    this._skip = new Set(['adapter', 'adapter-guoba', 'example', 'other', 'system', 'temp', '_plugins_backup'])
  }

  /** Yunzai 的 PluginsLoader 单例（跨包动态 import，失败不抛错） */
  async _getLoader() {
    if (this._loader) return this._loader
    try {
      const file = pathToFileURL(path.join(this._yunzaiApp, 'lib', 'plugins', 'loader.js')).href
      this._loader = (await import(file)).default
    } catch {
      this._loader = null
    }
    return this._loader
  }

  /** 已加载插件 key 集合（60s 缓存，避免每次全量遍历 priority） */
  async _loadedSet() {
    const now = Date.now()
    if (this._loadedKeys && now - this._loadedAt < 60000) return this._loadedKeys
    const loader = await this._getLoader()
    const set = new Set()
    try {
      for (const item of loader?.priority ?? []) {
        if (item?.key) set.add(String(item.key))
      }
    } catch {}
    this._loadedKeys = set
    this._loadedAt = now
    return set
  }

  /** 目录总大小（字节，排除 node_modules），10 分钟缓存 */
  _dirSize(dir) {
    const now = Date.now()
    const cached = this._sizeCache.get(dir)
    if (cached && now - (this._sizeAt.get(dir) || 0) < 600000) return cached
    let total = 0
    const walk = (d, depth) => {
      if (depth > 8) return
      let entries = []
      try { entries = fs.readdirSync(d, {withFileTypes: true}) } catch { return }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else {
          try { total += fs.statSync(full).size } catch {}
        }
      }
    }
    walk(dir, 0)
    this._sizeCache.set(dir, total)
    this._sizeAt.set(dir, now)
    return total
  }

  /**
   * 全量插件健康列表
   */
  async list() {
    const loaded = await this._loadedSet()
    let dirs = []
    try {
      dirs = fs.readdirSync(this._pluginsDir, {withFileTypes: true}).filter((e) => e.isDirectory())
    } catch {
      return []
    }
    const out = []
    for (const d of dirs) {
      const name = d.name
      if (this._skip.has(name) || name.startsWith('.') || name.startsWith('_')) continue
      const dir = path.join(this._pluginsDir, name)
      // 插件形态：index.js 入口 或 apps/ 目录（TRSS 约定二选一）
      const hasIndex = fs.existsSync(path.join(dir, 'index.js'))
      let appsCount = 0
      try {
        appsCount = fs.readdirSync(path.join(dir, 'apps')).filter((f) => f.endsWith('.js')).length
      } catch {}
      if (!hasIndex && !appsCount) continue // 不是插件形态，跳过
      const isLoaded = loaded.has(name)
      // 该插件在 loader 里注册的类实例数
      let classes = 0
      try {
        const loader = await this._getLoader()
        classes = (loader?.priority ?? []).filter((x) => x?.key === name).length
      } catch {}
      out.push({
        name,
        loaded: isLoaded,
        classes,
        appsCount,
        hasIndex,
        dataBytes: this._dirSize(dir),
      })
    }
    out.sort((a, b) => Number(b.loaded) - Number(a.loaded) || b.dataBytes - a.dataBytes)
    return out
  }
}

export default PluginHealthService
