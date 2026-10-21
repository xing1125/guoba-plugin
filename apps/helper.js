import path from 'path'
import {cfg, _paths} from "#guoba.platform";
import {sendToMaster} from '#guoba.utils'

export class GuobaHelp extends plugin {

  constructor(e) {
    super({
      name: '荧后台帮助',
      dsc: '荧后台帮助',
      event: 'message',
      priority: 100,
      rule: [
        {
          // 「锅巴」旧名保留兼容
          reg: '^#?(荧后台|锅巴)(帮助|菜单|说明|功能|指令|命令|使用说明|help)$',
          fnc: 'getHelp',
          permission: 'master',
        },
        // 可通过`#荧后台重启`重载`guoba.support.js`
        {
          reg: '^#?(荧后台|锅巴)重启$',
          fnc: 'restart',
          permission: 'master',
        },
      ],
    })
  }

  async init() {
    // 引导用户进行配置
    this.firstGuide()

  }

  async getHelp() {
    let msg = [
      '荧后台帮助：\n' +
      'https://github.com/xing1125/guoba-plugin'
    ]

    if(this.e?.platform) {
      msg.push('[请在后台查看地址]')
      for(const item of msg){
        console.log(item)
        this.e.reply(item)
      }
      return 
    }

    return this.e.reply(msg)
  }

  async restart() {
    if (Guoba && Guoba.reload) {
      await Guoba.reload()
      return this.e.reply('荧后台重启成功~')
    } else {
      return this.e.reply('奇怪，服务似乎并没有启动……')
    }
  }

  // 首次安装锅巴时的引导
  async firstGuide() {
    if (!cfg.get('base.guide')) {
      return
    }
    cfg.set('base.guide', false)
    sendToMaster([
      segment.image(path.join(_paths.pluginResources, 'images/help.jpg'))
    ])
  }

}
