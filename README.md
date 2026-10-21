# YingPanel（荧后台）

`YingPanel` 是 `Yunzai-Bot` 的后台管理面板，提供配置、插件、数据、审计等一整套图形化运维界面。

> 本项目 fork 自开源项目 [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin)（锅巴插件），
> 在此基础上做了深度定制：品牌与图标重制、控制台重新设计、全站设计系统统一、移动端适配、数据库健康与备份面板等。
> 插件目录名、路由前缀与包名仍沿用 `guoba`，属于技术标识，不影响使用。

> 管理面板仅支持 V3 / V4 版本的 Yunzai；V2 版本 Yunzai 仅支持迁移至 V3 功能。

具体功能可在安装插件后，通过发送 `#荧后台帮助` 查看。

## 已实现的功能

- [x] 品牌体系
    - [x] 荧 头像版应用图标（`build/brand/avatar.svg` 矢量源，可导出 favicon/PWA 全套尺寸）
    - [x] 自绘毛玻璃菜单图标集 `gmg`（28 枚，按功能分色）+ 线性图标集 `gm`（工具条/按钮）
- [x] 主人登录
    - [x] #荧后台登录（兼容旧指令 #锅巴登录）
    - [x] 控制台验证码登录 / 移动端一次性免密链接
- [x] 配置文件管理（保存即生效，无需重启）
- [x] 插件管理
    - [x] 插件配置
    - [x] 安装、卸载插件 [@0卡苏打水](https://github.com/CikeyQi)
- [x] 编辑喵喵帮助 [@realhuhu](https://github.com/realhuhu)
- [x] 数据总览 / 群数据 / 用户统计 / 签到中心 / 大屏投屏
- [x] 数据库健康检查与在线备份 / 恢复
- [x] 操作审计与登录日志
- [x] V2 云崽平滑迁移至 V3（[视频教程](https://www.bilibili.com/video/BV1fP411T7KM)）

## 安装插件

#### 第 1 步：下载插件

在云崽根目录下打开终端，运行：

```bash
git clone --depth=1 https://github.com/xing1125/guoba-plugin.git ./plugins/Guoba-Plugin/
```

> 目录名保持 `Guoba-Plugin` 是为了兼容已有部署与配置路径，请勿改成其他名字。

#### 第 2 步：安装依赖

##### 方式 1：采用 pnpm

> 注：如果你不是通过 `pnpm` 安装的云崽，请【**不要**】使用此方式，见方式 2。

```bash
pnpm install --filter=guoba-plugin
```

> 注：请务必直接复制上述命令，否则可能出现依赖丢失。
> `--filter=guoba-plugin` 表示只安装本插件依赖（包名未改，仍为 `guoba-plugin`）。

##### 方式 2：采用 npm 或 cnpm

```bash
npm install express multer jsonwebtoken better-sqlite3
```

如果执行失败，可把 `npm` 换成 `cnpm`（需先 `npm install cnpm -g --registry=https://registry.npmmirror.com`）。

#### 第 3 步：运行插件

依赖安装完成后直接启动 Bot 即可，默认端口 `50831`（可在 `config/application.yaml` 中修改）。

启动后在控制台可以看到访问地址，复制到浏览器打开。如果访问不到，请发送 `#荧后台帮助`。

## 更新

一般会自动更新；如需手动更新，发送 `#荧后台更新`。

> 注意：本仓库是定制分支，`#荧后台更新` 会从本仓库拉取，而不是上游锅巴仓库。

# 功能预览

- 主界面
  ![001](./resources/images/readme/001.png)

- 控制台
  ![002](./resources/images/readme/002.png)

- 基础配置
  ![003](./resources/images/readme/003.png)

- 群组配置
  ![004](./resources/images/readme/004.png)

- 编辑喵喵帮助
  ![005](./resources/images/readme/005.png)

# 免责声明

1. 功能仅限内部交流与小范围使用，严禁用于任何商业用途或盈利。
2. 图片与其他素材均来自网络，仅供交流学习使用，如有侵权请联系删除。
3. 本项目为 [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) 的二次开发分支，原始版权归上游作者所有。

# 致谢

- **Guoba-Plugin**（本项目上游）
    - [github](https://github.com/guoba-yunzai/guoba-plugin)
    - [gitee](https://gitee.com/guoba-yunzai/guoba-plugin)
- **Yunzai-Bot**
    - [gitee](https://gitee.com/Le-niao/Yunzai-Bot)
    - [github](https://github.com/Le-niao/Yunzai-Bot)
- **Yunzai 插件索引**
    - [gitee](https://gitee.com/yhArcadia/Yunzai-Bot-plugins-index)
    - [github](https://github.com/yhArcadia/Yunzai-Bot-plugins-index)
- **Miao-Plugin**
    - [github](https://github.com/yoimiya-kokomi/miao-plugin)
