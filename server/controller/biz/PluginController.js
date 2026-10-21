import {autowired, Result} from '#guoba.framework';
import {ApiController, GuobaSupportMap, cfg} from '#guoba.platform'

export default class PluginController extends ApiController {

  pluginService = autowired('pluginService')
  dbService = autowired('dbService')
  dbService = autowired('dbService')

  constructor(guobaApp) {
    super('/plugin', guobaApp)
  }

  registerRouters() {
    // 获取plugin列表
    this.get('/list', this.getPlugins)
    // 获取plugin readme
    this.get('/readme', this.getPluginReadme)

    // 安装plugin
    this.put('/install', this.installPlugin)
    // 卸载plugin
    this.put('/uninstall', this.uninstallPlugin)

    // 获取plugin icon（直接显示图片）
    this.get('/s/:pluginName/icon', this.getPluginIcon)
    // 获取plugin配置数据
    this.get('/s/:pluginName/config', this.getPluginConfig)
    // 设置plugin配置数据
    this.put('/s/:pluginName/config', this.setPluginConfig)

    // 执行操作
    this.post('/do/:pluginName/action', this.doAction)
  }

  /** 写审计 */
  _audit(req, action, target, detail) {
    try {
      this.dbService?.writeAudit?.({
        actor: String(req.user?.username || ''),
        action,
        target: String(target ?? ''),
        detail: detail ?? '',
        ip: String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      })
    } catch {
      /* 审计失败不阻断主流程 */
    }
  }

  /**
   * 获取插件列表
   * @param req.query.force 是否清空缓存强制刷新
   * @return {Promise<Result>}
   */
  async getPlugins(req) {
    let {force} = req.query
    force = force === 'true'
    let data = await this.pluginService.getPlugins(force)
    return Result.ok(data)
  }

  async getPluginReadme(req) {
    let {link, force} = req.query
    force = force === 'true'
    let text = await this.pluginService.getReadmeText(link, force)
    return Result.ok(text)
  }

  async installPlugin(req) {
    let {link, autoRestart = true, autoNpmInstall = true} = req.body
    if (!link || typeof link !== 'string') {
      return Result.error('link不能为空')
    }
    link = link.trim()
    if (/[;&|`$(){}#!<>]/.test(link)) {
      return Result.error('链接包含非法字符')
    }
    const whitelist = cfg.get('base.gitInstallWhitelist') || ['github.com', 'gitee.com', 'gitlab.com', 'gitcode.com']
    let parsed
    try {
      parsed = new URL(link)
    } catch {
      return Result.error('无效的仓库地址')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return Result.error('仅支持 http/https 协议')
    }
    const hostname = parsed.hostname.toLowerCase()
    if (!whitelist.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
      return Result.error(`不允许从 ${hostname} 安装插件，请在荧后台设置中添加白名单`)
    }
    let text = await this.pluginService.installPlugin(link, autoRestart, autoNpmInstall)
    this._audit(req, 'plugin.install', link)
    return Result.ok(text)
  }

  async uninstallPlugin(req) {
    let {name} = req.body
    name = name?.toString?.()?.trim?.()
    if (!name) {
      return Result.error('name不能为空')
    }
    let nameArr = name.split(',')
    if (nameArr.length === 0) {
      return Result.error('name不能为空')
    }
    if (nameArr.includes('miao-plugin')) {
      return Result.error('抱歉，由于miao-plugin是重要插件，不能卸载！')
    }
    let text = await this.pluginService.uninstallPluginBatch(nameArr)
    this._audit(req, 'plugin.uninstall', nameArr.join(','))
    return Result.ok(text)
  }

  getSupport(pluginName) {
    let supportObject = GuobaSupportMap.get(pluginName)
    if (!supportObject) {
      throw '该插件不支持荧后台'
    }
    return supportObject
  }

  // 获取插件icon（如果有）
  getPluginIcon(req, res) {
    let {pluginName} = req.params
    let supportObject = this.getSupport(pluginName)
    let {pluginInfo} = supportObject
    if (!pluginInfo || !pluginInfo.iconPath) {
      return Result.error('该插件没有配置iconPath')
    }
    res.sendFile(pluginInfo.iconPath)
    return Result.VOID
  }

  // 获取插件配置数据（如果有）
  async getPluginConfig(req) {
    let {pluginName} = req.params
    let supportObject = this.getSupport(pluginName)
    let {configInfo} = supportObject
    let getConfigData = configInfo?.getConfigData
    if (typeof getConfigData !== 'function') {
      return Result.error('该插件没有配置getConfigData')
    }
    return Result.ok(await getConfigData())
  }

  // 设置插件配置数据
  async setPluginConfig(req) {
    let {pluginName} = req.params
    let supportObject = this.getSupport(pluginName)
    let {configInfo} = supportObject
    let setConfigData = configInfo?.setConfigData
    if (typeof setConfigData !== 'function') {
      return Result.error('该插件没有配置setConfigData')
    }
    this._audit(req, 'plugin.config', pluginName, {keys: Object.keys(req.body || {}).slice(0, 20)})
    let flag = await setConfigData(req.body, {Result})
    if (flag instanceof Result) {
      /* 插件自己报错时不做广播，避免把运行中的实例改坏 */
      if (flag.ok !== false) this._afterPluginSave(pluginName, configInfo)
      return flag
    }
    this._afterPluginSave(pluginName, configInfo)
    return Result.ok(flag)
  }

  /**
   * 插件配置保存后的收尾：广播变更，让用 Bot.on('guoba.config.change') 的插件当场失效缓存。
   * 插件可以在 configInfo 里声明 hotReload：
   *   hotReload: true            → 保存后已即时生效
   *   hotReload: false           → 明确需要重启
   *   不声明（undefined/null）    → 视为未知，前端提示「如未生效请重启」
   */
  _afterPluginSave(pluginName, configInfo) {
    const hot = configInfo?.hotReload
    try {
      const bot = globalThis.Bot
      if (bot && typeof bot.em === 'function') {
        bot.em('guoba.config.change', {
          key: `plugin.${pluginName}`,
          plugin: pluginName,
          file: configInfo?.configFile || '',
          hot: hot !== false,
          ts: Date.now(),
        })
        globalThis.logger?.mark?.(`[Guoba] 插件配置已更新：${pluginName}${hot === true ? '（已热生效）' : hot === false ? '（需重启）' : ''}`)
      }
    } catch (e) {
      globalThis.logger?.warn?.(`[Guoba] 插件配置广播失败（${pluginName}）：${e.message}`)
    }
  }

  // 执行插件的 action
  async doAction(req) {
    const {pluginName} = req.params
    const body = req.body
    const supportObject = this.getSupport(pluginName)
    const {configInfo} = supportObject
    const actions = configInfo?.actions
    if (!actions) {
      return Result.error('没有配置 actions')
    }
    const action = actions[body.action]
    if (!action) {
      return Result.error(`action "${body.action}" 不存在`)
    }
    if (typeof action !== 'function') {
      return Result.error(`action "${body.action}" 不是一个方法`)
    }
    return action(body.args, {Result})
  }

}
