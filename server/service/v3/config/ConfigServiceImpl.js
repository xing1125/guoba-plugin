import lodash from 'lodash'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {YamlReader} from "#guoba.framework"
import {isTRSS} from '#guoba.adapter'
import {_paths} from '#guoba.platform'
/* 云崽核心配置单例：写盘后直接清它的缓存 key，让它下次 get 立刻重读，
   不必等 chokidar 的 5s 防抖。Cfg 是匿名类实例，config 是普通对象，删 key 即可，
   不改云崽本体（更新时不产生冲突）。 */
import coreCfg from '../../../../../../lib/config/config.js'

// 创建可使用相对路径的import方法
const {GI, GID} = Guoba.createImport(import.meta.url)
// 引入模块
const IConfigService = await GID('#/service/interface/IConfigService.js')
const {getConfigReader} = await GI('./utils/ConfigUtils.js')
const {getConfigTabs, configFile} = await GI('./model/useConfig.js')

const CfgUtilsAdapter = await (async () => {
  if (isTRSS) {
    return await GI('./utils/TRSSConfigUtils.js')
  }
  return await GI('./utils/MiaoConfigUtils.js')
})()

export default class ConfigServiceImpl extends IConfigService {

  constructor(app) {
    super(app)
  }

  async getConfigTabs() {
    return getConfigTabs()
  }

  async getConfigData(key) {
    let jsonData = getConfigReader(key, configFile).jsonData
    if (Array.isArray(jsonData)) {
      return jsonData
    }
    return this.handleConfigData('get', key, jsonData)
  }

  async setConfigData(key, data) {
    data = this.handleConfigData('set', key, data)
    const reader = getConfigReader(key, configFile)
    this.backupConfigFile(key, reader)
    reader.setData(data)
    return this.applyHot(key, data)
  }

  async removeCardForm(formKey, cardKey) {
    const reader = getConfigReader(cardKey, configFile)
    this.backupConfigFile(cardKey, reader)
    reader.deleteKey(formKey)
    return this.applyHot(cardKey, null)
  }

  /* ------------------------------ 热生效 ------------------------------ */

  /** 整份配置都不能热的（key → 原因） */
  static NO_HOT = {
    'system.redis': 'Redis 连接池已按旧参数建立，需重启后重建连接',
    'system.server': '端口/证书在启动时绑定，需重启后重新监听',
    'system.qq': '账号信息在适配器握手时确定，需重启后重连',
  }

  /** 个别字段不能热的（key → 字段名列表） */
  static NO_HOT_FIELDS = {
    'system.bot': {
      chromium_path: '浏览器路径在渲染器启动时读取',
      puppeteer_ws: '远程浏览器连接在渲染器启动时建立',
    },
  }

  /** 判断本次保存能否立刻生效 */
  checkHot(key, data) {
    if (ConfigServiceImpl.NO_HOT[key]) {
      return {hot: false, reason: ConfigServiceImpl.NO_HOT[key]}
    }
    const fields = ConfigServiceImpl.NO_HOT_FIELDS[key]
    if (fields && data && typeof data === 'object') {
      for (const [field, reason] of Object.entries(fields)) {
        if (Object.prototype.hasOwnProperty.call(data, field)) return {hot: false, reason}
      }
    }
    return {hot: true, reason: ''}
  }

  /**
   * 让运行中的实例立刻看到新配置
   * - 核心配置：清 Cfg 的缓存 key + 触发 change_xxx（如 change_bot 重新 init 日志）
   * - 插件配置：同步广播 guoba.config.change，订阅者当场清自己的缓存
   */
  applyHot(key, data) {
    const {hot, reason} = this.checkHot(key, data)
    const file = configFile[key] || ''
    const name = String(key || '').split('.').pop()
    const result = {hot, reason, key, file}

    /* 核心配置：即便最终判定需重启，也先把缓存清掉 —— 下次读到的至少是磁盘上的新值 */
    if (!file.startsWith('/plugins/')) {
      try {
        delete coreCfg.config[`config.${name}`]
        const hook = coreCfg[`change_${name}`]
        if (typeof hook === 'function') hook.call(coreCfg)
        result.coreReloaded = true
      } catch (e) {
        result.coreReloaded = false
        globalThis.logger?.warn?.(`[Guoba] 核心配置热重载失败（${key}）：${e.message}`)
      }
    }

    /* 同步广播：Bot.em 是同步 emit，订阅者在这条 HTTP 返回前就完成失效 */
    try {
      const bot = globalThis.Bot
      if (bot && typeof bot.em === 'function') {
        bot.em('guoba.config.change', {key, file, name, hot, ts: Date.now()})
        result.broadcast = true
      }
    } catch (e) {
      globalThis.logger?.warn?.(`[Guoba] 配置变更广播失败（${key}）：${e.message}`)
    }

    globalThis.logger?.mark?.(`[Guoba] 配置已${hot ? '热更新' : '写入（需重启）'}：${key}`)
    return result
  }

  /** 每份备份保留数量 */
  static BACKUP_KEEP = 10

  /**
   * 写配置前自动备份（自用精简版，不做审计 UI）
   * - 备份原始文件字节，保留注释原貌
   * - 每个配置 key 保留最近 10 份，超出自动清理
   * - 目录：data/guobaConfigBackup/<key>/<时间戳>_<文件名>
   * - 恢复：把备份文件复制回原路径重启即可
   */
  backupConfigFile(key, reader) {
    try {
      const src = reader?.yamlPath
      if (!src || !fs.existsSync(src)) return
      const safeKey = String(key || 'unknown').replace(/[^\w.-]/g, '_')
      const backupDir = path.join(_paths.root, 'data', 'guobaConfigBackup', safeKey)
      fs.mkdirSync(backupDir, {recursive: true})
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      const dest = path.join(backupDir, `${stamp}_${path.basename(src)}`)
      fs.copyFileSync(src, dest)
      // 清理超出保留数量的旧备份
      const files = fs.readdirSync(backupDir)
        .filter((f) => /^\d{8}-\d{6}_/.test(f))
        .sort()
      while (files.length > ConfigServiceImpl.BACKUP_KEEP) {
        fs.unlinkSync(path.join(backupDir, files.shift()))
      }
      logger?.info?.(`[Guoba] 配置已备份：${key} → ${dest}`)
    } catch (e) {
      // 备份失败不阻断保存流程，但要留痕
      logger?.error?.(`[Guoba] 配置备份失败（不影响本次保存）：${e.message}`)
    }
  }

  /* ------------------------------ 版本 / 对比 / 导出导入 ------------------------------ */

  /** 备份根目录：<bot>/data/guobaConfigBackup */
  _backupRoot() {
    return path.join(_paths.root, 'data', 'guobaConfigBackup')
  }

  /** key → 备份目录名，必须与 backupConfigFile 内保持一致 */
  _safeKey(key) {
    return String(key || 'unknown').replace(/[^\w.-]/g, '_')
  }

  /** 版本文件名白名单：<YYYYMMDD-HHmmss>_<文件名>，挡掉路径穿越 */
  _checkVersionFile(file) {
    const name = String(file ?? '')
    if (!/^\d{8}-\d{6}_[\w.-]+$/.test(name) || name.includes('..') || /[\\/]/.test(name)) {
      throw new Error('版本文件名不合法')
    }
    return name
  }

  /** '20261021-042840' → 本地时间毫秒，解析不了给 0 */
  _stampToMs(stamp) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(stamp ?? ''))
    if (!m) return 0
    const time = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]),
    ).getTime()
    return Number.isFinite(time) ? time : 0
  }

  /** 该配置当前在磁盘上的绝对路径 */
  _currentPath(key) {
    let reader
    try {
      reader = getConfigReader(key, configFile)
    } catch {
      throw new Error('找不到该配置的文件路径')
    }
    const p = reader?.yamlPath
    if (!p) throw new Error('找不到该配置的文件路径')
    return p
  }

  /** 版本列表（时间倒序，最新在前） */
  listVersions(key) {
    const dir = path.join(this._backupRoot(), this._safeKey(key))
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      // 目录不存在 = 还没有任何备份，不算错误
    }
    const versions = []
    for (const file of names) {
      if (!/^\d{8}-\d{6}_[\w.-]+$/.test(file) || file.includes('..') || /[\\/]/.test(file)) continue
      let stat
      try {
        stat = fs.statSync(path.join(dir, file))
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      const stamp = file.slice(0, 15)
      versions.push({
        file,
        stamp,
        time: this._stampToMs(stamp),
        size: stat.size,
        target: file.slice(16),
      })
    }
    versions.sort((a, b) => b.time - a.time || b.file.localeCompare(a.file))
    return {
      key,
      currentFile: configFile[key] || '',
      currentPath: this._currentPath(key),
      versions,
    }
  }

  /** 读某版本 yaml 原文（保留注释，不做解析） */
  readVersion(key, file) {
    const name = this._checkVersionFile(file)
    const p = path.join(this._backupRoot(), this._safeKey(key), name)
    if (!fs.existsSync(p)) throw new Error('版本文件不存在')
    const stat = fs.statSync(p)
    if (stat.size > 512 * 1024) throw new Error('配置文件过大，暂不支持在线查看')
    const currentPath = this._currentPath(key)
    return {
      file: name,
      stamp: name.slice(0, 15),
      time: this._stampToMs(name.slice(0, 15)),
      size: stat.size,
      content: fs.readFileSync(p, 'utf8'),
      currentContent: fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : '',
    }
  }

  /** 行级 LCS 对比：历史版本当旧、当前磁盘当新 */
  diffVersion(key, file) {
    const name = this._checkVersionFile(file)
    const p = path.join(this._backupRoot(), this._safeKey(key), name)
    if (!fs.existsSync(p)) throw new Error('版本文件不存在')
    const stamp = name.slice(0, 15)
    const oldLines = splitLines(fs.readFileSync(p, 'utf8'))
    const currentPath = this._currentPath(key)
    const newLines = splitLines(fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : '')

    /* 两文件总行数过大时 LCS 的 O(n*m) 吃不消，退化成集合计数 */
    if (oldLines.length + newLines.length > 3000) {
      const {added, removed, unchanged} = countDiff(oldLines, newLines)
      globalThis.logger?.mark?.(`[Guoba] 配置对比降级（行数过多）：${key} ${name}`)
      return {file: name, stamp, time: this._stampToMs(stamp), added, removed, unchanged, lines: [], truncated: true}
    }
    const {added, removed, unchanged, lines} = lcsDiff(oldLines, newLines)
    return {file: name, stamp, time: this._stampToMs(stamp), added, removed, unchanged, lines}
  }

  /** 回滚到某历史版本（先把当前状态备份，回滚本身也能再回滚） */
  async restoreVersion(key, file) {
    const name = this._checkVersionFile(file)
    const dir = path.join(this._backupRoot(), this._safeKey(key))
    const src = path.join(dir, name)
    if (!fs.existsSync(src)) throw new Error('版本文件不存在')
    const reader = getConfigReader(key, configFile)
    const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    this.backupConfigFile(key, reader)
    const after = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    const added = after.filter((f) => !before.has(f)).sort()
    const backupOf = added.length ? added[added.length - 1] : ''
    fs.copyFileSync(src, reader.yamlPath)
    /* 传解析后的数据而不是 null：applyHot 内部 checkHot 要靠字段判断 NO_HOT_FIELDS
       （chromium_path / puppeteer_ws）。传 null 会让「改了这些字段却报 hot:true」，
       前端就会误显示「已即时生效」而实际必须重启。 */
    let parsed = null
    try { parsed = YAML.parse(fs.readFileSync(src, 'utf8')) } catch { parsed = null }
    const res = this.applyHot(key, parsed)
    logger?.mark?.(`[Guoba] 配置已回滚：${key} ← ${name}（回滚前已备份 ${backupOf || '无'}）`)
    return {hot: res.hot, reason: res.reason, restoredFrom: name, backupOf, key}
  }

  /** 导出当前配置原文（保留注释） */
  exportConfig(key) {
    const p = this._currentPath(key)
    if (!fs.existsSync(p)) throw new Error('配置文件不存在')
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return {
      key,
      filename: `${String(key || 'config').replace(/\./g, '-')}_${stamp}.yaml`,
      content: fs.readFileSync(p, 'utf8'),
    }
  }

  /** 导入配置：校验全部通过才落盘 */
  async importConfig(key, content) {
    if (typeof content !== 'string') throw new Error('配置内容必须是字符串')
    if (content.length > 262144) throw new Error('配置内容过大（上限 256KB）')
    let parsed
    try {
      parsed = YAML.parse(content)
    } catch (e) {
      throw new Error(`YAML 解析失败：${e.message}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置内容必须是一个 YAML 对象')
    }

    const reader = getConfigReader(key, configFile)
    const dir = path.join(this._backupRoot(), this._safeKey(key))
    const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    this.backupConfigFile(key, reader)
    const after = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    const added = after.filter((f) => !before.has(f)).sort()
    const backupOf = added.length ? added[added.length - 1] : ''
    const bytes = Buffer.byteLength(content)
    fs.writeFileSync(reader.yamlPath, content, 'utf8')
    /* 同 restoreVersion：把真正写进去的解析结果交给 applyHot，
       否则改到 NO_HOT_FIELDS 也会误报 hot:true */
    const res = this.applyHot(key, parsed)
    logger?.mark?.(`[Guoba] 配置已导入：${key}（${bytes} 字节，导入前已备份 ${backupOf || '无'}）`)
    return {hot: res.hot, reason: res.reason, bytes, backupOf, key}
  }

  needHandleConfigKey = [
    'system.other',
    'system.group',
  ]
  needHandleFieldKey = [
    'masterQQ', 'disableAdopt', 'whiteGroup', 'blackGroup', 'blackQQ',
    'whiteQQ', 'blackUser', 'whiteUser', 'botAlias', 'enable', 'disable',
  ]

  /**
   * 处理配置里可能出现的特殊数据（空值等）
   */
  handleConfigData(action, key, data) {
    if (!data || Array.isArray(data)) {
      return data
    }
    const handler = (itemData) => {
      let newData = {}
      for (let [oKey, oVal] of Object.entries(itemData || {})) {
        let field = oKey
        let value = oVal

        if (action === 'get') {
          // 此处特殊处理，因为前端form的field不能是纯数字，只处理一层
          if (/^\d+$/.test(field)) {
            field = YamlReader.CONFIG_INTEGER_KEY + field
          }
        }

        // 处理空值
        if (this.needHandleConfigKey.includes(key) && this.needHandleFieldKey.includes(oKey)) {
          if (value == null || value === '') {
            value = []
          }
          if (Array.isArray(value)) {
            value = value.filter(str => str != null && str !== '')
          }
        }

        // 特殊处理
        const handleRes = CfgUtilsAdapter.handleConfigData(action, key, field, value)
        field = handleRes.field
        value = handleRes.value

        if (action === 'get') {
          newData[field] = value
        } else {
          lodash.set(newData, field, value)
        }
      }
      return newData
    }

    if (key === 'system.group') {
      let obj = handler(data)
      obj = CfgUtilsAdapter.handleGroupConfig(action, obj)
      for (let [oKey, oVal] of Object.entries(obj)) {
        obj[oKey] = handler(oVal)
      }
      return obj
    }
    return handler(data)
  }

}

/* ------------------------------ 行级 diff 工具 ------------------------------ */

/** 按行切分：去掉行尾 \r，空文件按 0 行处理 */
function splitLines(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!src) return []
  const lines = src.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 标准行级 LCS diff（a 当旧、b 当新）
 * 返回 lines 里 '-' 是旧有新无，'+' 是新有旧无，' ' 是两边都有
 */
function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  /* dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度，扁平化成一维 Int32Array 省内存 */
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }
  const lines = []
  let added = 0
  let removed = 0
  let unchanged = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({type: ' ', text: a[i]})
      i++; j++; unchanged++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      lines.push({type: '-', text: a[i]})
      i++; removed++
    } else {
      lines.push({type: '+', text: b[j]})
      j++; added++
    }
  }
  while (i < n) { lines.push({type: '-', text: a[i++]}); removed++ }
  while (j < m) { lines.push({type: '+', text: b[j++]}); added++ }
  return {added, removed, unchanged, lines}
}

/** 超大文件的降级计数：多重集合相交长度，不做位置对齐 */
function countDiff(a, b) {
  const pool = new Map()
  for (const line of a) pool.set(line, (pool.get(line) || 0) + 1)
  let common = 0
  for (const line of b) {
    const left = pool.get(line) || 0
    if (left > 0) {
      pool.set(line, left - 1)
      common++
    }
  }
  return {added: b.length - common, removed: a.length - common, unchanged: common}
}
