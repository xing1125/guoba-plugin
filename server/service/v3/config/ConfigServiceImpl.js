import lodash from 'lodash'
import fs from 'node:fs'
import path from 'node:path'
import {YamlReader} from "#guoba.framework"
import {isTRSS} from '#guoba.adapter'
import {_paths} from '#guoba.platform'

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
  }

  async removeCardForm(formKey, cardKey) {
    const reader = getConfigReader(cardKey, configFile)
    this.backupConfigFile(cardKey, reader)
    reader.deleteKey(formKey)
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
