# Glance New Tab for fnOS

将 [Glance](https://github.com/glanceapp/glance) 设为 Chrome 新标签页，并在 fnOS / FN Connect 登录状态失效时自动恢复会话。

扩展兼容两种 Glance 部署方式：

- fnOS 原生应用，例如 `https://你的飞牛ID.5ddd.com/app/glance-homepage/`；
- 通过 FN Connect 发布的 Docker 服务，例如 `https://服务ID.你的飞牛ID.5ddd.com/`。

扩展不会预置任何 NAS 地址，也不会保存 fnOS 账号、密码、Token 或 Cookie。

## 功能

- 接管 Chrome 新标签页并打开指定的 Glance 页面；
- 原生应用出现 `invalid token` 时自动访问 fnOS 页面恢复登录；
- Docker 服务出现“FN Connect 暂无权限访问该服务”时自动经过官方 FN Connect 入口恢复；
- 浏览器冷启动时先预热 fnOS 会话，减少首次打开失败；
- 同一浏览器会话内优先直达 Glance，避免不必要的跳转；
- 自动识别 FN Connect 选择的局域网线路，原生应用自动推导本地地址；
- Docker 未填写本地端口时，可从 fnOS 桌面打开 Glance，让扩展自动验证并记住地址；
- 恢复期间显示加载动画，成功渲染 Glance 后再展示页面；
- 支持自动、浅色和深色界面；
- 可选会话保活与本地 `file://` 新标签页。

## 环境要求

- Chrome 111 或更高版本；
- 可正常访问的 Glance 页面；
- 使用 fnOS 远程地址时，建议安装并启用“飞牛 fn Connect 小助手”Chrome 扩展；
- Chrome 中不能同时启用另一个接管新标签页的扩展，例如 Custom New Tab URL。

## Chrome 安装方法

当前项目以“加载已解压的扩展程序”的方式安装。

1. 在 GitHub 仓库页面点击 **Code → Download ZIP**，或者从 Releases 下载发布包；
2. 解压下载的文件，并确保所选目录中直接包含 `manifest.json`；
3. 在 Chrome 地址栏打开 `chrome://extensions/`；
4. 打开右上角的“开发者模式”；
5. 点击“加载已解压的扩展程序”；
6. 选择解压后的 `Glance-New-Tab-for-fnOS` 目录；
7. 如已安装其他新标签页扩展，请将其停用；
8. 可在 Chrome 扩展菜单中固定本扩展，方便随时进入设置。

安装完成后会自动打开设置页面。以后可以点击工具栏中的扩展图标，或者在扩展详情页点击“扩展程序选项”重新进入设置。

### 更新扩展

下载新版后，将文件更新到原来的扩展目录，再打开 `chrome://extensions/` 并点击本扩展的“重新加载”按钮。尽量保持安装目录不变，以便 Chrome 保留同一个本地扩展身份和已有设置。

## 使用教程

### 1. 填写 Glance 主页网址

在“主页网址”中填写实际访问 Glance 的完整地址。

fnOS 原生应用示例：

```text
https://你的飞牛ID.5ddd.com/app/glance-homepage/
```

FN Connect Docker 服务示例：

```text
https://服务ID.你的飞牛ID.5ddd.com/
```

同样支持对应的 `fnos.net` 地址。示例中的“你的飞牛ID”和“服务ID”需要替换成你自己的地址内容。

### 2. 配置 fnOS 登录恢复

建议保持“fnOS 登录恢复”开启，然后点击“根据主页网址自动填写”。扩展会自动推导：

- fnOS 根网址；
- 登录状态检测网址；
- 原生应用所需的 `/__fnos/health` 路径；
- Docker Glance 所需的 `/api/healthz` 路径。

通常无需手动修改这两个地址。如果自动推导结果与实际部署不符，再根据你的反向代理配置进行调整。

### 3. 配置会话保活和外观

- “会话保活”默认每 10 分钟检测一次会话，可以延长浏览器运行期间的滑动会话；
- “等待提示时间”只控制何时显示人工处理提示，不会提前停止检测；
- 外观可以选择“跟随浏览器”“浅色”或“深色”。

会话保活无法改变 fnOS 自己的 Cookie 有效期。彻底关闭 Chrome 后，是否继续保持登录仍由 fnOS 决定；下次启动时扩展会通过官方页面重新恢复，而不是保存或伪造认证信息。

### Docker 的局域网地址（可选）

如果已经知道 Docker 映射端口，可以在“本机局域网主页”中填写，例如：

```text
http://192.168.1.10:18080/
```

这个地址只保存在当前电脑，不会通过 Chrome 同步到其他设备。

也可以留空。扩展在 FN Connect 选择局域网线路后会停留在 fnOS 桌面并提示：

1. 点击“允许并继续”，只授权扩展访问当前 NAS；较新版本的 Chrome 还可能显示一次“访问本地网络”确认；
2. 从 fnOS 桌面打开 Docker 中的 Glance；
3. 扩展检查该服务的 `/api/healthz` 和 Glance 页面结构；
4. 验证成功后记住局域网地址，以后的新标签页会直接使用它。

扩展不会扫描 NAS 端口，也不会把任意新打开的网页当成 Glance。自动识别只在明确提示后的两分钟内进行，并且候选服务必须位于同一台 NAS。如果同一 NAS 上有多个 Glance 实例，也可以在设置中手动填写所需实例的地址。

### 4. 保存并测试

点击“保存并测试恢复”。扩展会新建一个标签页并执行完整流程：

```text
恢复或确认 fnOS 会话 → 检测 Glance → 打开主页
```

确认 Glance 正常显示后，新建标签页即可日常使用。

## 工作方式

### fnOS 原生应用

浏览器完整启动后的第一个新标签页会主动预热 fnOS 会话：

```text
新标签页
  → fnOS 根页面
  → fn Connect 或现有登录状态恢复会话
  → Glance 健康检查
  → Glance 主页
```

同一浏览器会话中的后续新标签页优先打开 Glance。只有检测到 `invalid token` 时，才会返回 fnOS 根页面恢复登录。连续失败达到限制后会停止自动跳转并显示重新检测按钮，避免循环闪屏。

### FN Connect Docker 服务

Docker 冷启动或无权限时，扩展会先访问官方 FN ID 引导地址：

```text
https://5ddd.com/你的飞牛ID/
```

FN Connect 会解析 NAS，并选择直连、DDNS 或中继线路。官方跳转完成后，扩展通过 `/api/healthz` 和页面状态确认服务权限，再进入 Docker Glance。迟到的旧页面检测结果会被忽略，避免在官方入口和 Docker 地址之间反复闪屏。

如果官方入口最终落到 `10.x`、`172.16-31.x` 或 `192.168.x` 等私有网络地址：

- 已保存并可访问局域网 Glance 时，扩展直接使用本机地址；
- 未保存时，扩展指导用户从 fnOS 桌面打开 Docker Glance 并自动学习；
- 离开局域网或本机健康检查失败时，扩展自动回到原来的 FN Connect 远程流程。

## 设置说明

| 设置 | 作用 |
| --- | --- |
| 启用新标签页 | 控制是否自动打开配置的主页 |
| 主页网址 | Glance 原生应用或 Docker 服务的完整地址 |
| fnOS 登录恢复 | 登录失效时通过 fnOS / FN Connect 官方页面恢复 |
| fnOS 根网址 | 用于恢复当前 NAS 登录状态的入口 |
| 登录状态检测网址 | 判断原生应用或 Docker 服务是否已经可用 |
| 本机局域网主页 | 当前电脑使用的局域网 Glance 地址；Docker 可手填，也可从 fnOS 桌面自动学习 |
| 等待提示时间 | 超时后显示人工处理提示，不会中止后台检测 |
| 会话保活 | Chrome 运行期间定期检查会话 |
| 检测间隔 | 会话保活的执行频率，范围为 1 至 120 分钟 |
| 外观 | 跟随浏览器、浅色或深色 |

## 本地文件作为新标签页

也可以把 `file:///...` 地址设为主页。保存时 Chrome 会请求本地文件访问权限。如果没有弹出提示，请进入：

```text
chrome://extensions/ → Glance New Tab for fnOS → 详细信息
```

然后开启“允许访问文件网址”。使用普通 Glance 地址时不需要该权限。

## 常见问题

### 新标签页停留在 `invalid token`

1. 确认“fnOS 登录恢复”已开启；
2. 点击“根据主页网址自动填写”，重新保存；
3. 确认飞牛 fn Connect 小助手已启用；
4. 点击“保存并测试恢复”；
5. 如果出现 fnOS 登录页面，手动登录一次，扩展会继续进入 Glance。

### Docker 页面显示“FN Connect 暂无权限访问该服务”

先确认从 fnOS 桌面能够正常进入该 Docker 服务，然后执行“保存并测试恢复”。首次线路检测可能需要数秒；扩展会等待官方 FN Connect 完成线路选择。

### 局域网内无法打开 Docker Glance

如果设置中的“本机局域网主页”为空，新建标签页后按页面提示授权当前 NAS，再从 fnOS 桌面打开 Docker Glance。识别成功后，设置页会显示学到的局域网地址。

如果提示“检测到的服务不是 Glance”，请确认打开的是 Glance 容器而不是其他 Docker 应用；也可以直接填写实际的 `http://NAS-IP:映射端口/`。

### 打开新标签页没有进入 Glance

- 确认设置中的总开关已开启；
- 在 `chrome://extensions/` 中确认扩展没有报错；
- 停用其他接管新标签页的扩展；
- 点击扩展卡片上的“重新加载”，再打开新标签页测试。

### 关闭浏览器后仍需重新恢复登录

这是 fnOS Cookie 生命周期造成的正常情况。扩展不申请 Cookie 权限，也不会把临时 Token 改造成永久凭据；它会在浏览器下次启动时重新走官方恢复流程。

## 权限与隐私

- `storage`：保存主页地址、功能开关、时间间隔和外观设置；
- `tabs`：在当前新标签页中执行恢复和跳转；
- `scripting`：在用户授权的 NAS 页面显示恢复提示并识别 Glance；
- `5ddd.com` / `fnos.net`：识别登录失效页面并检测 fnOS / Glance 状态；
- 可选的局域网 http(s) 主机：仅在用户点击允许或手动保存局域网地址时，授权指定 NAS IP；
- 可选的 `file:///*`：仅在用户选择本地文件时请求。

扩展不包含广告、统计或遥测，不向开发者发送数据，也没有申请 `cookies`、`history`、`webRequest` 或 `webRequestBlocking` 权限。详细说明见 [PRIVACY.md](PRIVACY.md)。

## 开发与校验

项目不含运行时第三方依赖，也不需要构建步骤。需要 Node.js 18 或更高版本：

```bash
npm test
npm run validate
```

## 相关项目与文档

- [Glance](https://github.com/glanceapp/glance)
- [fnOS 应用开发文档](https://developer.fnnas.com/docs/guide/)
- [fnnas-docs](https://github.com/ckcoding/fnnas-docs)

本项目是独立的社区扩展，与 Glance、飞牛 fnOS 或 FN Connect 官方团队不存在隶属关系。

## 许可证

本扩展采用 [MIT License](LICENSE)。Glance 本身由其原作者以 AGPL-3.0 许可证发布，不包含在本扩展中。
