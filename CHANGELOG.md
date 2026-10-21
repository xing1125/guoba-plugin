# 2.4.8

荧之心智升级：记忆/情绪干预（写操作）。

* `YingMindService` 新增 `deleteMemory` / `updateMemory` / `setEmotion`：读-改-原子写（tmp+rename），oldText 前 60 字漂移校验防 YingAI 并发增删导致错位
* `YingMindController` 新增 POST memories/delete、memories/update、emotion/set：confirm 二次确认 + 限流 10/min + writeAudit（yingmind.memory.delete / update / yingmind.emotion.set）
* **需重启 Bot 生效**


# 2.4.7

新模块「告警中心」：签到/插件/系统三源告警聚合。

* 新增 `AlertCenterService`：聚合 `SignHealthService.evaluate`（签到）、`PluginHealthService.list`（未装载插件）、os 内存水位与 wmic 磁盘剩余（10 分钟缓存，失败静默跳过）
* 新增 `AlertCenterController`：`GET /admin/alert-center/list`
* 新增菜单「告警中心」（`alert-center`，图标 `gmg:bell`）+ 权限目录
* 只读聚合不落库；通知仍走 SignHealthService 私聊主人那套
* **需重启 Bot 生效**


# 2.4.6

新模块「插件健康」：磁盘插件的真实装载状态与数据体积。

* 新增 `PluginHealthService`：对比磁盘插件目录与 Yunzai `lib/plugins/loader.js` 的 `priority`（key = 插件目录名）判定加载状态；目录大小递归统计（排除 node_modules/隐藏文件，10 分钟缓存）；跳过 adapter/example/system 等非插件约定目录
* 新增 `PluginHealthController`：`GET /admin/plugin-health/list`
* 新增菜单「插件健康」（`plugin-health`，图标 `gmg:pulse`）+ 权限目录
* **需重启 Bot 生效**

# 2.4.5

新模块「荧之心智」：只读观测荧（YingAI）的记忆 / 关系 / 情绪。

* 新增 `YingMindService`：读 YingAI 落盘数据（`data/memory`、`data/relationships`、`data/emotion`），零侵入只读，探针/测试文件（`__probe_`/`test_` 前缀）剔除，读失败静默跳过
* 新增 `YingMindController`：`GET /admin/yingmind/groups|memories|relations|emotion`
* 群名从运行时 `Bot.gl` 解析；记忆按 value 重要度排序，关系按 affinity 亲密度排序
* 新增菜单「荧之心智」（`ying-mind`，图标 `gmg:heart`），权限目录同步
* **需重启 Bot 生效**（Controller 启动时加载、菜单启动时下发）

# 2.4.4

实时对话增强：看到群里的完整聊天 + 群筛选按名称。

* `YingAILiveService` 新增全局 `message` 监听：把「群友说话但荧没回」的普通群消息也收进实时流（`source: 'chat'`，左侧弱化样式），与 diag 问答对按「群|人|内容」去重，diag 优先
* `groups()` 带群名（从运行时 `Bot.gl` 解析，尝试原值 / 数字 / `@chatroom` 三种 key），前端下拉按群名称筛选、流水行头显示群名
* 监听全程 try/catch 静默，绝不影响消息链路；`stop()` 卸载监听
* **需重启 Bot 生效**（Service 在启动时挂监听）

# 2.4.2

控制台「实时对话」：在后台看到荧在群里的实时回复，并支持以 Bot 身份代发。

* 新增 `YingAILiveService`：**零侵入**复用 YingAI 自己的诊断文件（`data/diag/YYYY-MM-DD.jsonl`），每 2 秒增量读今日+昨日文件尾部，按 `ts` 去重进内存环形缓冲（上限 2000 条）
* 不监听 YingAI 内部事件（那套框架庞杂易碎），只读它落盘的权威诊断数据，口径与诊断大屏 / 自检一致（探针行同规则剔除）
* 新增 `YingAILiveController`：`GET /admin/yingai-live/stream`（增量拉取，`after` 游标）、`GET /admin/yingai-live/groups`（有实时流的群，按活跃排序）、`POST /admin/yingai-live/reply`（以 Bot 身份代发，复用 `ConsoleService.send`）
* 代发成功后立刻把「我发的」注入实时流，前端能马上看到自己的消息和荧的后续回复同屏
* 服务在 `appMounted` 启动（`yingAILiveService.start()`）
* **主动撤回不可用**：协议端（ComWeChat / GSUIDCore / Milky）只实现 `send_message`/`upload_file`，无 `delete_msg`/`recall_msg` 动作，故控制台只提供「已发送列表 + 撤回标灰说明」，不糊弄

# 2.4.1

角色面板（喵喵面板图）改造：接入 miao 官方角色表，改成「筛选 + 角色网格 + 选中角色图片区」的信息架构。

* `MiaoImgService` 新增 `catalog(kind)`：**官方角色表 + 磁盘目录合并**——没上传图的角色也会列出来，选中即可上传，不用靠手打名字（也就不会把目录名写错）
* 新增 `_catalogMeta()`：读 `miao-plugin/resources/meta-{gs,sr}/character/data.json`（原神 127 + 星铁 108），带出星级与属性；属性统一成中文（原神 `cryo` → 冰，星铁 `虚数` → 虚无，原神 `multi` → 多属性），进程内缓存
* 自定义目录（不在官方表里的，如 `default`、新角色实机目录）标 `custom: true`，与官方角色区分
* 新增 `GET /admin/miao-img/catalog?kind=`；`characters` 接口保留不动（旧调用不受影响）
* 排序：原神 → 星铁 → 自定义，同游戏内按星级降序、名称拼音序

# 2.4.0

三件套：群战力榜、定时任务中心、签到健康度 + 告警。

**群战力榜（只读）**

* 新增 `RankService`：扫描 `miao:rank:*`（60 秒缓存），解析 `miao:rank:<gid>:<type>:<charId>` 与 `miao:rank:uid-info:<uid>` 的账号映射，角色名从 `miao-plugin/resources/meta-{gs,sr}/character/data.json` 取，读不到时退化成 `#id`
* 新增 `RankController`：`GET /admin/rank/groups`、`GET /admin/rank/board?gid=&type=&charId=&limit=`
* **Redis 5 兼容**：客户端 4.7.1 没有 `zRevRangeWithScores`，而 `ZRANGE ... REV` 在 Redis 5 会语法错误，改走 `ZREVRANGE key 0 N WITHSCORES` 原生命令
* `StatsService` 开放 `userNameMap()` / `groupNameMap()`

**定时任务中心**

* 新增 `CronService`：自写 5 段 cron 解析（`*/n`、区间、列表、`@daily` 别名），每 20 秒巡检，「同一分钟只跑一次」+ `last_run_at` 双保险，重启不重复触发
* 执行复用 `ConsoleService.exec` 模拟真实消息链路（`skipThrottle` 新参数跳过手动节流，危险指令视为已预授权），老插件零改造
* 新增 `CronController`：`/admin/cron/tasks|targets|history|preview|save|toggle|delete|run`，写接口 confirm + 限流 + 审计
* 任务存 admin.db `cron_task` 表（执行次数 / 失败数 / 最近结果），执行历史存 Redis（保留 100 条）
* 调度器在 `appMounted` 随后台启动；菜单新增「定时任务」（`/scheduler`），权限项 `scheduler`

**签到健康度 + 告警**

* 新增 `SignHealthService`：把 CK 失效 / 近 7 天全失败 / 悬空绑定 / 今日成功率折算成 0-100 健康分，规则命中生成带稳定 key 的告警
* 新告警第一次出现自动私聊每个 Bot 的第一个主人；已知告警不重复推送；快照存 Redis，重启不丢
* 30 分钟自动巡检（`appMounted` 启动）；`SignController` 新增 `GET /admin/sign/health`、`POST /admin/sign/health/check`

# 2.3.28

* **主题跟随系统**：头部深浅色开关改成三态（跟随系统 → 浅色 → 深色 → 跟随系统），默认「跟随系统」，读 `prefers-color-scheme`；系统切换深浅色时面板实时跟着变，不用刷新
* 用户显式点过就锁定，不再被系统改动打断；点回中间档恢复跟随。偏好存 `__YING__THEME__PREF__`，同时回写旧键 `__APP__DARK__MODE__`
* 开关滑块三档位：左=浅色、中=跟随系统（半白半深灰）、右=深色；悬停标题显示当前档位
* 登录页容器 1200px → 1120px，左栏（锁定区 / 立绘 / 版本行）再往右收一档

# 2.3.27

交互体验专项：命令面板、统一反馈、表格与空态、切页与首屏。

* **命令面板**：头部新增胶囊入口，`Ctrl+K`（macOS `⌘K`）任意位置唤起，`↑↓` 选择、`↵` 进入、`Esc` 关闭；空输入给 8 个常用入口，输入按字符顺序模糊匹配并高亮命中字，附「共 N 个页面」计数
* 面板只在打开时接管键盘，不再像原来那样全局吞掉回车与方向键
* **失败一定有提示**：请求层兜住所有未指定提示方式的失败（写操作 3s 窗口 / 读操作 15s 窗口，同文案去重），结束"点了没反应"；页面原有的 `catch {}` 静默兜底不再吞掉错误
* **防重复提交**：同一个 `METHOD+URL+参数` 的写请求在飞行中直接复用同一个 Promise，连点两下删除 / 清空 / 重启只会生效一次
* **表格**：二次加载（翻页 / 筛选 / 刷新）不再清空表格，改为压暗 + 顶部扫光；空态区分"本来就没有"和"筛掉了"，后者带关键字回显与「清空筛选」按钮；每页条数按页面记住
* **切页**：`fade-slide` 从 0.3s×2 压到 0.12s 出 / 0.2s 进、位移 30px→12px，切页等待从 600ms 降到约 320ms
* **首屏**：顶部进度条改品牌渐变（青→蓝→金）+ 柔光，并隐藏默认 spinner
* 登录页容器上限 1040px → 1200px，左栏整体再左移一档，卡片右侧留白与左栏对称
* 快捷键帮助里补上 `Ctrl/⌘ + K`

# 2.3.26

* 登录页改成标准左右结构：左边只有品牌（徽标字标 + 整身立绘 + 版本行），右边登录卡；大标题/说明/卖点/提示条全部删掉
* 插画白底在 `build/brand/gen-login-art.py` 里抠成 alpha（裁截图黑边 → 四边 flood fill → 收边羽化），导出带透明通道的 WebP（520×927 / 90 KB）
* 插画按 `clamp(200px, min(24vw, 40vh), 320px)` 缩放，整身立绘不裁切，矮屏不会把版本行顶出视口
* 容器上限 1040px、登录卡 400px、栏间距 72px；≤940 单列时收起插画与版本行
* 深色主题下没有白底了，只把亮度压到 0.82，插画里的气泡与云朵在暗底上像发光
* 「关于」页新增品牌卡：方形插画（身后垫天蓝柔光，避免白衬衫糊在白卡上）+ 视觉说明 + 三枚品牌色卡

# 2.3.25

* 徽标重做：从参考图提炼元素（五瓣白花 / 领口金星 / 天蓝 + 暖金 / 背景气泡），替换人物头像版为几何徽标
* 登录页按新品牌重排：天空气泡底料、左侧品牌锁定区 + 双行标题 + 三条卖点 + 快捷指令提示，右侧登录卡加品牌发丝线
* 手机端登录页收成「锁定区 + 卡片」两段，不再把两行摊满整屏

# 2.3.24

* 品牌更名：GuobaAdmin → YingPanel（荧后台），登录页 / 侧边栏 / 关于页 / README 全量切换
* 应用图标换成「荧」头像（矢量源 `build/brand/avatar.svg`，导出 favicon 与 PWA 全尺寸）
* 侧栏菜单图标改为自绘毛玻璃方块集 `gmg`（28 枚，按功能分色）；按钮/工具条仍用线性 `gm`
* 指令兼容：`#荧后台登录` / `#荧后台帮助` / `#荧后台重启`，同时保留 `#锅巴*` 旧名
* 登录页品牌区重排为「头像 + 中英字标 + 大标题」，修掉重复产品名与图标顶字

# 1.0.0

* 嗨害嗨，这是第一个版本呢
* 哦吼吼`吼吼吼`吼吼吼