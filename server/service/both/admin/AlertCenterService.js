import {autowired, Service} from '#guoba.framework'
import {_paths} from '#guoba.platform'
import os from 'node:os'
import path from 'node:path'
import {exec} from 'node:child_process'

/**
 * 统一告警中心
 *
 * 聚合三类告警源，输出统一结构：
 *   { key, level: 'bad'|'warn', source, title, detail }
 *   - 签到：复用 SignHealthService.evaluate（CK 失效 / 连续失败 / 悬空绑定 / 成功率）
 *   - 插件：PluginHealthService 里「磁盘有文件但未加载」的插件
 *   - 系统：内存水位 / 磁盘剩余（Windows wmic，失败静默跳过）
 *
 * 只读聚合，不落库不通知（通知已有 SignHealthService 私聊主人那套）。
 */
export class AlertCenterService extends Service {

  signHealthService = autowired('signHealthService')
  pluginHealthService = autowired('pluginHealthService')

  constructor(app) {
    super(app)
    /** 磁盘信息缓存 10 分钟（wmic 查询不便宜） */
    this._diskCache = null
    this._diskAt = 0
  }

  async list() {
    const started = Date.now()
    const alerts = []
    /* ---- 1. 签到健康 ---- */
    try {
      const snap = await this.signHealthService.evaluate({notify: false})
      for (const a of snap?.alerts ?? []) {
        alerts.push({
          key: `sign:${a.key}`,
          level: a.level === 'bad' ? 'bad' : 'warn',
          source: '签到',
          title: a.title,
          detail: a.detail,
        })
      }
    } catch { /* 签到体检失败不阻塞其它源 */ }

    /* ---- 2. 插件装载 ---- */
    try {
      const plugins = await this.pluginHealthService.list()
      for (const p of plugins) {
        if (p.loaded) continue
        alerts.push({
          key: `plugin:${p.name}`,
          level: 'bad',
          source: '插件',
          title: `插件 ${p.name} 未被加载`,
          detail: `磁盘上有 ${p.appsCount} 个 apps 文件，但 Yunzai 加载器里没有它——多半是语法错误或加载超时，去「运行日志」搜插件名确认`,
        })
      }
    } catch { /* 同上 */ }

    /* ---- 3. 系统 ---- */
    try {
      const total = os.totalmem()
      const free = os.freemem()
      const usedPct = Math.round(((total - free) / total) * 100)
      if (usedPct >= 90) {
        alerts.push({
          key: 'sys:mem',
          level: 'bad',
          source: '系统',
          title: `内存使用率 ${usedPct}%`,
          detail: `剩余 ${(free / 1073741824).toFixed(1)} GB / 共 ${(total / 1073741824).toFixed(1)} GB，插件可能开始被 OOM 杀掉`,
        })
      } else if (usedPct >= 80) {
        alerts.push({
          key: 'sys:mem',
          level: 'warn',
          source: '系统',
          title: `内存使用率 ${usedPct}%`,
          detail: `剩余 ${(free / 1073741824).toFixed(1)} GB，留意插件内存增长`,
        })
      }
      for (const d of this._disks()) {
        const freeGb = d.freeGb
        if (freeGb <= 5) {
          alerts.push({
            key: `sys:disk:${d.caption}`,
            level: 'bad',
            source: '系统',
            title: `${d.caption} 盘仅剩 ${freeGb.toFixed(1)} GB`,
            detail: '数据库写入 / 备份 / 日志随时可能失败，立刻清理或扩容',
          })
        } else if (freeGb <= 15) {
          alerts.push({
            key: `sys:disk:${d.caption}`,
            level: 'warn',
            source: '系统',
            title: `${d.caption} 盘剩余 ${freeGb.toFixed(1)} GB`,
            detail: '空间偏低，备份与日志会加速吃满',
          })
        }
      }
    } catch { /* 系统信息拿不到就跳过 */ }

    alerts.sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1))
    return {
      alerts,
      critical: alerts.filter((a) => a.level === 'bad').length,
      warn: alerts.filter((a) => a.level === 'warn').length,
      checkedAt: started,
      costMs: Date.now() - started,
    }
  }

  /** Windows 磁盘剩余（wmic，10 分钟缓存；非 Windows / 查询失败返回空） */
  _disks() {
    const now = Date.now()
    if (this._diskCache && now - this._diskAt < 600000) return this._diskCache
    const out = []
    try {
      if (/^win/i.test(process.platform)) {
        const raw = exec('wmic logicaldisk get caption,freespace,size /format:csv', {timeout: 8000}).toString()
        for (const line of raw.split('\n')) {
          const cols = line.trim().split(',').map((s) => s.trim())
          if (cols.length < 3 || !/^[A-Za-z]:$/.test(cols[1] || '')) continue
          const free = Number(cols[2])
          const size = Number(cols[3])
          if (!Number.isFinite(free) || !Number.isFinite(size) || size <= 0) continue
          out.push({caption: cols[1], freeGb: free / 1073741824, totalGb: size / 1073741824})
        }
      }
    } catch { /* wmic 不存在或超时就跳过磁盘维度 */ }
    this._diskCache = out
    this._diskAt = now
    return out
  }
}

export default AlertCenterService
