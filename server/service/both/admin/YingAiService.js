import path from 'path'
import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import {createYingAiData} from './YingAiData.js'

/**
 * YingAI 私聊数据服务（锅巴 Service 壳）
 * 纯数据逻辑在 YingAiData.js（不依赖框架，可独立测试）
 */
export class YingAiService extends Service {

  constructor(app) {
    super(app)
    this._data = createYingAiData(path.resolve(_paths.pluginRoot, '..', 'YingAIPrivate'))
  }

  overview() { return this._data.overview() }
  users(q) { return this._data.users(q) }
  messages(uid, q) { return this._data.messages(uid, q) }
  compare() { return this._data.compare() }
  insights(uid) { return this._data.insights(uid || '') }
  setEnabled(uid, enabled) { return this._data.setEnabled(uid, enabled) }
  invalidate() { this._data.invalidate() }
}

export default YingAiService
