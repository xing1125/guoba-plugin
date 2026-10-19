import {autowired, Service} from '#guoba.framework'

const {GI} = Guoba.createImport(import.meta.url)
const {useAllMenus} = await GI('../system/model/menus/index.js')
const {readMenuCfg, writeMenuCfg} = await GI('../system/model/menus/menuCfg.js')

/**
 * 导航管理：菜单显隐 + 排序偏好
 *
 *  - getPrefs()：全量菜单项 + 当前偏好（含被屏蔽项，供管理页展示）
 *  - setPrefs()：保存 { hidden, order }，写审计；改完由前端刷新页面重建路由/菜单
 *
 * 屏蔽只影响后台 UI（菜单/路由/快捷入口），不涉及任何 RBAC 权限判断。
 */
export class MenuPrefsService extends Service {

  dbService = autowired('dbService')

  async getPrefs() {
    const menus = await useAllMenus()
    const cfg = await readMenuCfg()
    const items = menus.map((m) => {
      const key = m?.meta?.perm || m?.path || ''
      return {
        key,
        title: m?.meta?.title || key,
        path: m?.path || '',
        icon: m?.meta?.icon || '',
        /** 无 perm 的为锅巴自带插件菜单页（暂不参与屏蔽/排序，仅展示） */
        plugin: !m?.meta?.perm,
        /** 固定显示项（首页 / 导航管理自身），管理页开关禁用 */
        fixed: key === 'home' || key === 'nav-mgr',
        hidden: cfg.hidden.includes(key),
      }
    })
    return {items, hidden: cfg.hidden, order: cfg.order}
  }

  async setPrefs({hidden, order} = {}, ctx = {}) {
    const hid = Array.isArray(hidden) ? hidden.map(String).filter(Boolean) : []
    const ord = Array.isArray(order) ? order.map(String).filter(Boolean) : []
    if (hid.length > 100 || ord.length > 100) {
      throw new Error('配置项过多，拒绝保存')
    }
    if (hid.includes('home') || hid.includes('nav-mgr')) {
      throw new Error('首页与导航管理不可屏蔽')
    }
    const saved = await writeMenuCfg({hidden: hid, order: ord})
    try {
      this.dbService?.writeAudit?.({
        actor: String(ctx.actor || ''),
        action: 'menuPrefs.set',
        target: 'nav',
        detail: {hidden: saved.hidden, orderCount: saved.order.length},
        ip: String(ctx.ip || ''),
      })
    } catch {}
    return saved
  }
}
