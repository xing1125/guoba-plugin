import path from 'path'
import {Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import {createYingAiGroupData} from './YingAiGroupData.js'

/**
 * YingAI 群聊聊天记录数据服务（锅巴 Service 壳）
 * 纯数据逻辑在 YingAiGroupData.js（不依赖框架，可独立测试）
 * 数据源：<plugins>/YingAI/data/diag/*.jsonl
 */
export class YingAiGroupService extends Service {

  constructor(app) {
    super(app)
    this._data = createYingAiGroupData(path.resolve(_paths.pluginRoot, '..', 'YingAI'))
  }

  meta() { return this._data.meta() }
  dashboard(q) { return this._data.dashboard(q) }
  turns(q) { return this._data.turns(q) }
  invalidate() { this._data.invalidate() }
}

export default YingAiGroupService
