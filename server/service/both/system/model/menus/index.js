import {isV2} from '#guoba.adapter'

const {GI} = Guoba.createImport(import.meta.url)
const {SystemMenus} = await GI('./systemMenus.js')
const {usePluginsMenu} = await GI('./pluginMenus.js')
const {readMenuCfg} = await GI('./menuCfg.js')

/** 不可屏蔽的菜单 key（首页 + 导航管理自身） */
const FIXED_KEYS = new Set(['home', 'nav-mgr'])

/** 菜单 key：优先 meta.perm，插件菜单退回 path */
function menuKey(m) {
  return m?.meta?.perm || m?.path || ''
}

/** 全量菜单（未应用显隐/排序偏好），导航管理页用这份 */
export async function useAllMenus() {
  const menus = []
  // 控制台放第一项：日常运维最常用（发消息 / 模拟指令）
  menus.push(SystemMenus.console)
  menus.push(SystemMenus.home)
  menus.push(SystemMenus.dashboard)
  menus.push(SystemMenus.screen)
  menus.push(SystemMenus.sysinfo)
  menus.push(SystemMenus.files)
  menus.push(SystemMenus.miaoImg)
  menus.push(SystemMenus.groups)
  menus.push(SystemMenus.usersData)
  menus.push(SystemMenus.rank)
  menus.push(SystemMenus.cmdStats)
  menus.push(SystemMenus.scheduler)
  menus.push(SystemMenus.yingai)
  menus.push(SystemMenus.yingMind)
  menus.push(SystemMenus.chatDiag)
  menus.push(SystemMenus.dbHealth)
  menus.push(SystemMenus.pluginsData)
  menus.push(SystemMenus.pluginHealth)
  menus.push(SystemMenus.alertCenter)
  menus.push(SystemMenus.sign)
  menus.push(SystemMenus.navMgr)
  menus.push(SystemMenus.data)
  menus.push(SystemMenus.config)
  menus.push(...(await usePluginsMenu()))
  menus.push(SystemMenus.account)
  menus.push(SystemMenus.uid)
  menus.push(SystemMenus.sysUsers)
  menus.push(SystemMenus.audit)
  menus.push(SystemMenus.logs)
  menus.push(SystemMenus.about)
  return menus
}

// noinspection JSUnusedGlobalSymbols
export async function useMenuList() {
  if (isV2) return useMenuListV2()
  const menus = await useAllMenus()

  /* 导航管理偏好：屏蔽 + 排序（Redis 读取失败时维持默认） */
  let hidden = []
  let order = []
  try {
    const cfg = await readMenuCfg()
    hidden = cfg.hidden
    order = cfg.order
  } catch {}
  const hid = new Set(hidden)
  const out = menus.filter((m) => !hid.has(menuKey(m)) || FIXED_KEYS.has(menuKey(m)))
  if (order.length) {
    const idx = new Map(order.map((k, i) => [k, i]))
    const withIdx = out.map((m, i) => ({m, i, o: idx.get(menuKey(m))}))
    // 已排序项按 order 在前排；未排序项保持默认相对顺序，跟在后面
    withIdx.sort((a, b) => {
      const ao = a.o ?? order.length + a.i
      const bo = b.o ?? order.length + b.i
      return ao - bo
    })
    return withIdx.map((x) => x.m)
  }
  return out
}

async function useMenuListV2() {
  return []
}
