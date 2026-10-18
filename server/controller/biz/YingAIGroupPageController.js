import path from 'path'
import fs from 'fs'
import {RestController} from '#guoba.framework'
import {_paths} from '#guoba.platform'

/**
 * YingAI 聊天记录诊断大屏 · 页面宿主（/yingai-group）
 *
 * 挂在 /api 之外，因此不受 TokenInterceptor 拦截，可以直接在浏览器打开：
 *   http://<host>:<port><挂载前缀>/yingai-group
 *
 * 页面本身不含任何数据，只是壳；数据全部由页面用登录令牌去调
 * /api/admin/yingai-group/* 实时获取（令牌见锅巴后台登录态）。
 */
export default class YingAIGroupPageController extends RestController {

  constructor(guobaApp) {
    super('/yingai-group', guobaApp)
  }

  registerRouters() {
    this.get('/', this.page)
    this.get('/page', this.page)
  }

  _file() {
    return path.resolve(_paths.pluginRoot, '..', 'YingAI', 'dashboard', 'live.html')
  }

  async page(req, res) {
    const file = this._file()
    try {
      const html = fs.readFileSync(file, 'utf8')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.send(html)
    } catch (e) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.status(500).send(`<pre style="color:#f87171;background:#0a0c14;padding:24px;font-family:monospace">诊断大屏页面缺失：${file}
${e?.message || e}

请确认 YingAI 插件下存在 dashboard/live.html。</pre>`)
    }
  }
}
