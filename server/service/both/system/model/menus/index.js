import {isV2} from '#guoba.adapter'

const {GI} = Guoba.createImport(import.meta.url)
const {SystemMenus} = await GI('./systemMenus.js')
const {usePluginsMenu} = await GI('./pluginMenus.js')

// noinspection JSUnusedGlobalSymbols
export async function useMenuList() {
  if (isV2) return useMenuListV2()
  const menus = []
  menus.push(SystemMenus.home)
  menus.push(SystemMenus.dashboard)
  menus.push(SystemMenus.screen)
  menus.push(SystemMenus.sysinfo)
  menus.push(SystemMenus.groups)
  menus.push(SystemMenus.usersData)
  menus.push(SystemMenus.yingai)
  menus.push(SystemMenus.pluginsData)
  menus.push(SystemMenus.sign)
  menus.push(SystemMenus.data)
  menus.push(SystemMenus.config)
  menus.push(...(await usePluginsMenu()))
  menus.push(SystemMenus.account)
  menus.push(SystemMenus.uid)
  menus.push(SystemMenus.sysUsers)
  menus.push(SystemMenus.audit)
  menus.push(SystemMenus.about)
  return menus
}

async function useMenuListV2() {
  return []
}
