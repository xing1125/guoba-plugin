// noinspection JSUnusedGlobalSymbols
export const SystemMenus = {
  // 首页菜单
  home: {
    path: '/home',
    name: 'Home',
    component: '/guoba/home/index',
    meta: {
      title: '首页',
      icon: 'bx:bx-home',
    },
  },
  // 账号管理
  account: {
    path: '/account',
    name: 'Account',
    component: '/guoba/system/account/index',
    meta: {
      title: '账号管理',
      icon: 'ant-design:user-outlined',
    },
  },
  // 游戏 UID（云崽管理后台扩展）
  uid: {
    path: '/uid',
    name: 'Uid',
    component: '/guoba/system/uids/index',
    meta: {
      title: '游戏 UID',
      icon: 'mdi:gamepad-variant-outline',
    },
  },
  // 数据管理（云崽管理后台扩展）
  data: {
    path: '/data',
    name: 'DataManage',
    component: '/guoba/system/data/index',
    meta: {
      title: '数据管理',
      icon: 'mdi:database-cog-outline',
    },
  },
  // 游戏签到（云崽管理后台扩展）
  sign: {
    path: '/sign',
    name: 'Sign',
    component: '/guoba/system/sign/index',
    meta: {
      title: '游戏签到',
      icon: 'mdi:calendar-check-outline',
    },
  },
  // 数据总览（云崽管理后台扩展）
  dashboard: {
    path: '/dashboard',
    name: 'Dashboard',
    component: '/guoba/system/dashboard/index',
    meta: {
      title: '数据总览',
      icon: 'ant-design:dashboard-outlined',
    },
  },
  // 状态大屏（云崽管理后台扩展）
  screen: {
    path: '/screen',
    name: 'BotScreen',
    component: '/guoba/system/screen/index',
    meta: {
      title: '状态大屏',
      icon: 'ant-design:fund-projection-screen-outlined',
    },
  },
  // 群数据（云崽管理后台扩展）
  groups: {
    path: '/groups',
    name: 'Groups',
    component: '/guoba/system/groups/index',
    meta: {
      title: '群数据',
      icon: 'mdi:account-group-outline',
    },
  },
  // 用户数据（云崽管理后台扩展）
  usersData: {
    path: '/users-data',
    name: 'UsersData',
    component: '/guoba/system/users/index',
    meta: {
      title: '用户数据',
      icon: 'mdi:account-multiple-outline',
    },
  },
  // 插件数据（云崽管理后台扩展）
  pluginsData: {
    path: '/plugins-data',
    name: 'PluginsData',
    component: '/guoba/system/plugins/index',
    meta: {
      title: '插件数据',
      icon: 'mdi:puzzle-outline',
    },
  },
  // 配置管理
  config: {
    path: '/config',
    name: 'Config',
    component: '/guoba/config/index',
    meta: {
      title: '配置管理',
      icon: 'ion:settings-outline',
    },
  },
  // 关于
  about: {
    path: '/about',
    name: 'about',
    component: '/guoba/about/index',
    meta: {
      title: '关于',
      icon: 'ant-design:info-circle-outlined',
    },
  },
}