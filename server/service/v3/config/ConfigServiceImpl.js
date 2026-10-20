import lodash from 'lodash'
import fs from 'node:fs'
import path from 'node:path'
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
