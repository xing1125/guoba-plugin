// noinspection JSUnusedGlobalSymbols
export const SystemMenus = {
  // 首页菜单
  home: {
    path: '/home',
    name: 'Home',
    component: '/guoba/home/index',
    meta: {
      perm: 'home',
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
      perm: 'account',
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
      perm: 'uid',
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
      perm: 'data',
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
      perm: 'sign',
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
      perm: 'dashboard',
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
      perm: 'screen',
      title: '状态大屏',
      icon: 'ant-design:fund-projection-screen-outlined',
    },
  },
  // 系统信息（云崽管理后台扩展）
  sysinfo: {
    path: '/sysinfo',
    name: 'SysInfo',
    component: '/guoba/system/sysinfo/index',
    meta: {
      perm: 'sysinfo',
      title: '系统信息',
      icon: 'ant-design:desktop-outlined',
    },
  },
  // 文件管理（云崽管理后台扩展）
  files: {
    path: '/files',
    name: 'WorkspaceFiles',
    component: '/guoba/system/files/index',
    meta: {
      perm: 'files',
      title: '文件管理',
      icon: 'ant-design:folder-open-outlined',
    },
  },
  // 喵喵面板图（云崽管理后台扩展）
  miaoImg: {
    path: '/miao-img',
    name: 'MiaoImg',
    component: '/guoba/system/miao-img/index',
    meta: {
      perm: 'miao-img',
      title: '喵喵面板图',
      icon: 'ant-design:picture-outlined',
    },
  },
  // 群数据（云崽管理后台扩展）
  groups: {
    path: '/groups',
    name: 'Groups',
    component: '/guoba/system/groups/index',
    meta: {
      perm: 'groups',
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
      perm: 'users-data',
      title: '用户数据',
      icon: 'mdi:account-multiple-outline',
    },
  },
  // AI 私聊（YingAIPrivate · 云崽管理后台扩展）
  yingai: {
    path: '/yingai',
    name: 'YingAi',
    component: '/guoba/system/yingai/index',
    meta: {
      perm: 'yingai',
      title: 'AI 私聊',
      icon: 'mdi:account-multiple-outline',
    },
  },
  // 插件数据（云崽管理后台扩展）
  pluginsData: {
    path: '/plugins-data',
    name: 'PluginsData',
    component: '/guoba/system/plugins/index',
    meta: {
      perm: 'plugins-data',
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
      perm: 'config',
      title: '配置管理',
      icon: 'ion:settings-outline',
    },
  },
  // 后台用户与角色（RBAC）
  sysUsers: {
    path: '/sys-users',
    name: 'SysUsers',
    component: '/guoba/system/sys-users/index',
    meta: {
      perm: 'sys-users',
      title: '后台用户',
      icon: 'ant-design:team-outlined',
    },
  },
  // 审计日志
  audit: {
    path: '/audit',
    name: 'AuditLog',
    component: '/guoba/system/audit/index',
    meta: {
      perm: 'audit',
      title: '审计日志',
      icon: 'ant-design:audit-outlined',
    },
  },
  // 关于
  about: {
    path: '/about',
    name: 'about',
    component: '/guoba/about/index',
    meta: {
      perm: 'about',
      title: '关于',
      icon: 'ant-design:info-circle-outlined',
    },
  },
}