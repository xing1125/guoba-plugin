import { autowired, Result } from '#guoba.framework'
import { ApiController } from '#guoba.platform'

/**
 * 系统信息接口（/api/admin/sysinfo）
 *
 * 只读。实时采集本机软硬件状态，供后台「系统信息」页展示：
 *   GET /info   全量快照（OS / 内核 / CPU / 内存 / Swap / 磁盘 / GPU / 电池 / 网络 / 运行时）
 */
export default class SysInfoController extends ApiController {

  sysInfoService = autowired('sysInfoService')

  constructor(guobaApp) {
    super('/admin/sysinfo', guobaApp)
  }

  registerRouters() {
    this.get('/', this.info)
    this.get('/info', this.info)
  }

  async info() {
    try {
      return Result.ok(await this.sysInfoService.info())
    } catch (e) {
      return Result.error(`读取系统信息失败：${e?.message || e}`)
    }
  }
}
