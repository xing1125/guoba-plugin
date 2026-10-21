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
      icon: 'gmg:home',
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
      icon: 'gmg:fingerprint',
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
      icon: 'gmg:gamepad',
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
      icon: 'gmg:database',
    },
  },
  // 签到中心（游戏签到 + 鸣潮签到，页内 tab 切换 · 云崽管理后台扩展）
  sign: {
    path: '/sign',
    name: 'Sign',
    component: '/guoba/system/sign/index',
    meta: {
      perm: 'sign',
      title: '签到中心',
      icon: 'gmg:calendar-check',
    },
  },
  // 鸣潮签到已并入 /sign 的页内 tab；waves-js 看板仍可经插件菜单 /plugin/extra/waves-dashboard 访问
  // 导航管理（菜单显隐 / 排序 · 云崽管理后台扩展）
  navMgr: {
    path: '/nav-mgr',
    name: 'NavMgr',
    component: '/guoba/system/nav-mgr/index',
    meta: {
      perm: 'nav-mgr',
      title: '导航管理',
      icon: 'gmg:nav',
    },
  },
  // 聊天诊断（YingAI 群聊诊断大屏 · 云崽管理后台扩展）
  chatDiag: {
    path: '/chat-diag',
    name: 'ChatDiag',
    component: '/guoba/system/chat-diag/index',
    meta: {
      perm: 'chat-diag',
      title: '聊天诊断',
      icon: 'gmg:pulse',
    },
  },
  // 控制台（发消息 / 模拟指令 · 云崽管理后台扩展）
  console: {
    path: '/console',
    name: 'Console',
    component: '/guoba/system/console/index',
    meta: {
      perm: 'console',
      title: '控制台',
      icon: 'gmg:console',
    },
  },
  // 数据健康（备份 / 完整性 · 云崽管理后台扩展）
  dbHealth: {
    path: '/db-health',
    name: 'DbHealth',
    component: '/guoba/system/dbhealth/index',
    meta: {
      perm: 'db-health',
      title: '数据健康',
      icon: 'gmg:dbcheck',
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
      icon: 'gmg:dashboard',
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
      icon: 'gmg:gauge',
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
      icon: 'gmg:cpu',
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
      icon: 'gmg:folder',
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
      icon: 'gmg:image',
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
      icon: 'gmg:users',
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
      icon: 'gmg:user',
    },
  },
  // 群战力榜（miao-plugin 排名数据 · 云崽管理后台扩展）
  rank: {
    path: '/rank',
    name: 'GroupRank',
    component: '/guoba/system/rank/index',
    meta: {
      perm: 'rank',
      title: '群战力榜',
      icon: 'gmg:gauge',
    },
  },
  // 定时任务（后台调度中心 · 云崽管理后台扩展）
  scheduler: {
    path: '/scheduler',
    name: 'Scheduler',
    component: '/guoba/system/scheduler/index',
    meta: {
      perm: 'scheduler',
      title: '定时任务',
      icon: 'gmg:pulse',
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
      icon: 'gmg:bot',
    },
  },
  // 插件健康（加载状态/数据体积 · 云崽管理后台扩展）
  pluginHealth: {
    path: '/plugin-health',
    name: 'PluginHealth',
    component: '/guoba/system/pluginhealth/index',
    meta: {
      perm: 'plugin-health',
      title: '插件健康',
      icon: 'gmg:pulse',
    },
  },
  // 告警中心（签到/插件/系统聚合 · 云崽管理后台扩展）
  alertCenter: {
    path: '/alert-center',
    name: 'AlertCenter',
    component: '/guoba/system/alertcenter/index',
    meta: {
      perm: 'alert-center',
      title: '告警中心',
      icon: 'gmg:bell',
    },
  },
  // 荧之心智（YingAI 记忆/关系/情绪观测 · 云崽管理后台扩展）
  yingMind: {
    path: '/ying-mind',
    name: 'YingMind',
    component: '/guoba/system/yingmind/index',
    meta: {
      perm: 'ying-mind',
      title: '荧之心智',
      icon: 'gmg:heart',
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
      icon: 'gmg:puzzle',
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
      icon: 'gmg:sliders',
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
      icon: 'gmg:shield',
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
      icon: 'gmg:clipboard',
    },
  },
  // 关于
  // 运行日志（云崽管理后台扩展）
  logs: {
    path: '/logs',
    name: 'RunLogs',
    component: '/guoba/system/logs/index',
    meta: {
      perm: 'logs',
      title: '运行日志',
      icon: 'gmg:terminal',
    },
  },
  about: {
    path: '/about',
    name: 'about',
    component: '/guoba/about/index',
    meta: {
      perm: 'about',
      title: '关于',
      icon: 'gmg:info',
    },
  },
}