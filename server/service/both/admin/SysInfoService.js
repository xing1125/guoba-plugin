import { Service } from '#guoba.framework'
import { createSysInfoData } from './SysInfoData.js'

/**
 * 系统信息服务（锅巴 Service 壳）
 * 纯采集逻辑在 SysInfoData.js（不依赖框架，可独立测试）
 */
export class SysInfoService extends Service {

  constructor(app) {
    super(app)
    this._data = createSysInfoData()
  }

  info() { return this._data.summary() }
  invalidate() { this._data.invalidate() }
}

export default SysInfoService
