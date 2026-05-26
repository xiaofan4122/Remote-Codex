# Remote Codex Project Overview

## 项目目标

Remote Codex 是一个面向远程使用的 Codex CLI 监控与控制壳。它把本地 `codex` 命令包装成两个入口：

- Electron 桌面端：显示原生 Codex TUI，保留本地终端交互体验、滚动历史和设置面板。
- Headless API 服务：在不打开窗口的情况下，通过本地 HTTP API 创建、控制和读取 Codex 会话。

项目同时内置飞书插件，让用户可以在飞书里发送消息控制 Codex，并把 Codex 输出回传到飞书卡片或文本消息。默认远程回复不再解析可视终端屏幕，而是走 Codex `app-server` 事件流，减少 TUI 状态栏、spinner、标题控制序列等噪声进入聊天回复。

## 启动方式

### 前置条件

- 安装依赖：`npm install`
- 本机 `PATH` 中需要有 `codex`
- 如未登录 Codex，需要先在普通终端里执行 Codex 登录流程

### Electron 桌面端

```bash
npm start
```

等价于运行 `electron .`，入口是 `src/main.js`。启动后会创建 Electron 窗口，并默认在配置的工作目录启动一个 Codex PTY 会话。

Codex TUI 默认参数来自 `src/config.js`：

```text
codex --no-alt-screen
```

`--no-alt-screen` 用于保留桌面终端滚动历史，避免 TUI 反复刷新备用屏导致历史不可读。

### Headless API

```bash
npm run api
```

等价于运行：

```bash
node src/api-server.js
```

默认监听：

```text
http://127.0.0.1:4317
```

常用端点包括：

- `GET /health`
- `GET /sessions`
- `POST /sessions`
- `POST /sessions/:id/input`
- `GET /sessions/:id/output?cursor=0`
- `POST /sessions/:id/resize`
- `DELETE /sessions/:id`
- `GET /plugins`
- `POST /plugins/feishu/connect`
- `GET /plugins/feishu/connect`
- `DELETE /plugins/feishu/connect`

如果设置了 `CODEX_API_TOKEN`，所有 API 请求需要携带：

```text
Authorization: Bearer <token>
```

### 安装本地启动器

```bash
npm run install:launchers
```

脚本 `scripts/install-launchers.sh` 会安装：

- `~/.local/bin/remote-codex`
- `~/.local/bin/remote-codex-api`
- `~/.local/share/applications/remote-codex.desktop`

通过这些启动器启动时，会把启动命令所在目录写入 `REMOTE_CODEX_LAUNCH_CWD`，作为默认 Codex 工作目录的候选值。

## 配置方式

默认配置在 `src/config.js` 的 `defaultConfig` 中。配置优先级是：

```text
环境变量 > 配置文件 > 默认值
```

配置文件路径选择逻辑：

- 优先使用 `REMOTE_CODEX_CONFIG`
- 兼容旧变量 `CODEX_SHELL_CONFIG`
- 默认使用 `~/.remote-codex.json`
- 如果新配置不存在但旧配置 `~/.codex-electron-shell.json` 存在，则读取旧配置

示例文件是 `config.example.json`。当前示例默认声明远程输出源为：

```json
{
  "remoteControl": {
    "responseSource": "app_server"
  }
}
```

常用环境变量：

- `CODEX_WORKDIR`：默认 Codex 工作目录
- `CODEX_COMMAND`：Codex 可执行文件路径
- `CODEX_ARGS`：PTY/TUI 启动参数
- `CODEX_EXEC_ARGS`：`codex exec` JSON 模式参数
- `CODEX_API_HOST` / `CODEX_API_PORT` / `CODEX_API_TOKEN`
- `FEISHU_ENABLED`
- `FEISHU_MODE`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_ALLOWED_OPEN_IDS`
- `FEISHU_ALLOWED_CHAT_IDS`

运行日志写入：

```text
~/.local/state/remote-codex/remote-codex.log
```

`src/logger.js` 会对 secret、token、password、authorization 等字段做脱敏。

## 主要模块

### `src/main.js`

Electron 主进程入口。负责：

- 创建 BrowserWindow
- 启动可视 Codex PTY 会话
- 管理 IPC：启动会话、选择目录、保存配置、飞书连接流程、插件动作
- 初始化 `CodexSessionManager`
- 初始化 `CodexAppServerRunner`
- 初始化 `RemoteSessionController`
- 初始化 `PluginManager`
- 在窗口加载完成后启动默认 Codex 会话

Electron 模式下，远程控制器通过 `sharedSessionProvider` 可以复用当前可视终端会话；但默认飞书回复源是 `app_server`，因此飞书消息通常不直接驱动可视 TUI。

### `src/api-server.js`

Headless HTTP API 入口。负责：

- 读取配置
- 创建本地 HTTP 服务
- 管理 Codex PTY 会话的增删改查
- 暴露插件列表和插件动作接口
- 暴露飞书一键连接接口
- 启动已启用插件

API 服务也使用同一个 `RemoteSessionController`，因此飞书远程命令和本地 API 会话共享同一套控制逻辑。

### `src/codexSessionManager.js`

Codex PTY 会话管理器，基于 `node-pty` 启动 `codex`。每个会话维护：

- `id`
- `command`
- `args`
- `cwd`
- 终端尺寸
- 创建与退出时间
- 输出 cursor
- 最近输出 chunk 缓冲

该模块主要服务于 Electron 可视终端、HTTP API 的 `/sessions` 系列端点，以及 `visual_terminal` 远程策略。

### `src/remoteSessionController.js`

远程消息到 Codex 的统一控制层。插件收到消息后不直接写 PTY，而是调用这里的 `handleMessage()`。它负责：

- 识别 `/start`、`/stop`、`/status`、`/tail`、`/approve`、`/deny`、方向键等远程命令
- 根据插件和全局配置选择输出源
- 自动创建会话
- 校验远程请求的工作目录是否在 `allowedWorkdirs` 内
- 聚合、节流和格式化输出
- 为飞书等插件创建可更新的回复流
- 在 `visual_terminal` 模式下清理 TUI 噪声和提取最终回答

### `src/codexAppServerRunner.js`

默认远程输出路径。它启动：

```text
codex app-server --listen stdio://
```

然后通过 JSON-RPC 风格的 stdio 协议：

- `initialize`
- `thread/start`
- `turn/start`
- 监听 `turn/completed`
- 监听 agent message delta 和 completed item
- 监听命令执行事件并格式化为活动信息

这个 runner 复用 thread id，所以同一个飞书会话可以延续上下文。代码里对 app-server 的命令和文件变更 approval 请求默认返回 `denied`，避免远程结构化模式下直接执行需审批动作。

### `src/codexExecRunner.js`

兼容的结构化输出路径。它运行：

```text
codex exec --json --color never --skip-git-repo-check <prompt>
```

如果已有 thread id，则运行：

```text
codex exec resume <threadId> <prompt>
```

它解析 stdout 的 JSONL 事件，提取活动信息和最终 agent message。当前默认不走该路径，除非把 `remoteControl.responseSource` 或插件级 `responseSource` 配为 `exec_json`。

### `src/plugins/pluginManager.js`

插件管理器。自动扫描 `src/plugins/*/index.js`，加载导出 `id` 和 `create()` 的插件。它负责：

- 插件发现
- 按配置启动 enabled 插件
- 停止和重启插件
- 调用插件动作
- 汇总插件状态

### `src/plugins/feishu/index.js`

内置飞书插件。支持：

- `long_connection`：飞书企业自建应用机器人，使用 `@larksuiteoapi/node-sdk` 的 WebSocket 长连接接收消息和卡片按钮回调
- `custom_webhook`：飞书群自定义机器人 webhook，只适合出站通知和测试，不支持接收命令

插件负责：

- 标准化飞书文本消息
- 校验 allowlist
- 去除提及文本
- 把消息转给 `RemoteSessionController`
- 发送普通文本、普通卡片或 CardKit streaming card
- 处理卡片按钮回调，将 Approve、Deny、Up、Down 等动作转换为远程命令
- 在卡片或权限调用失败时尝试申请缺失权限，并回退到文本发送

### `src/plugins/feishu/registrationManager.js`

飞书一键接入流程管理器。通过 SDK 的 `registerApp()` 创建授权流程，生成授权 URL 和二维码 data URL。授权完成后，调用主进程或 API 服务传入的 `onComplete`：

- 保存 app id 和 app secret
- 启用飞书插件
- 设置 `mode = long_connection`
- 记录授权用户 open id
- 将授权用户加入 `allowedOpenIds`
- 重启插件

### `src/renderer.js`、`src/preload.js`、`src/renderer.html`、`src/styles.css`

Electron 渲染层。使用 xterm.js 显示 Codex TUI，提供：

- 终端输入输出
- 终端 resize
- 最近 300 行终端 snapshot 回传
- 目录选择
- 重启 Codex
- 设置面板
- 飞书连接、取消、打开授权链接和二维码状态展示

## 飞书接入方式

### 推荐路径：Electron 设置面板

1. 启动桌面端：`npm start`
2. 打开 Settings
3. 点击 `Connect Feishu`
4. 打开授权链接或扫描二维码
5. 授权完成后，配置会写入 `~/.remote-codex.json` 或 `REMOTE_CODEX_CONFIG` 指定文件
6. 插件自动重启并进入 `long_connection` 模式
7. 将创建出的机器人加入目标飞书会话

授权完成后，配置会包含：

- `plugins.feishu.enabled = true`
- `plugins.feishu.mode = "long_connection"`
- `plugins.feishu.appId`
- `plugins.feishu.appSecret`
- `plugins.feishu.authorizedOpenId`
- `plugins.feishu.allowedOpenIds`
- `plugins.feishu.connectedAt`
- `plugins.feishu.connectSource = "register_app"`

### Headless 接入

启动 API：

```bash
npm run api
```

开始连接：

```bash
curl -X POST http://127.0.0.1:4317/plugins/feishu/connect \
  -H 'content-type: application/json' \
  -d '{}'
```

轮询状态：

```bash
curl http://127.0.0.1:4317/plugins/feishu/connect
```

返回 `waiting` 时，响应包含授权 `url` 和 `qrDataUrl`。授权完成后，状态变为 `complete`，服务保存配置并重启插件。

### 手工配置

也可以直接配置：

```json
{
  "plugins": {
    "feishu": {
      "enabled": true,
      "mode": "long_connection",
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "allowedOpenIds": ["ou_xxx"],
      "allowedChatIds": []
    }
  }
}
```

`allowedOpenIds` 和 `allowedChatIds` 都是 allowlist。只要配置了非空列表，飞书插件会拒绝列表外用户或群聊，并回复拒绝原因。

### 飞书远程命令

支持的命令：

```text
/start [cwd]
/stop
/status
/tail
/approve
/deny
/enter
/up
/down
/help
```

其他文本会作为 prompt 发送给 Codex。

`/start [cwd]` 只有在 `codex.allowedWorkdirs` 配置允许时才接受自定义 cwd；否则只能使用默认工作目录。这是为了避免飞书远程用户任意切换到本机其他路径。

## 当前远程输出策略

### 默认策略：`app_server`

当前默认配置是：

```text
remoteControl.responseSource = app_server
remoteControl.outputMode = final
plugins.feishu.streaming = true
remoteControl.flushIntervalMs = 250
```

在这个策略下：

1. 飞书收到消息后调用 `RemoteSessionController.handleMessage()`。
2. 控制器检测到 Feishu 的 `responseSource` 是 `app_server`。
3. 控制器使用 `CodexAppServerRunner`，启动或复用 `codex app-server --listen stdio://`。
4. 每个飞书 conversation 对应一个 exec session state，并维护 `threadId`。
5. prompt 通过 `turn/start` 发给 Codex app-server。
6. 运行过程中的命令执行、输出 delta、reasoning 状态会被整理为 activity text。
7. agent message delta 或 completed agent message 会被整理为最终回复。
8. 如果飞书支持 streaming card，则先创建 CardKit 卡片，过程中 update 卡片内容，结束时关闭 streaming mode；否则发送普通卡片或文本。

这个策略的主要目的是真正消费 Codex 的结构化事件，而不是从屏幕文本里猜最终答案。因此它能避免：

- spinner 字符
- TUI 边框
- 状态栏
- shell title / OSC 控制序列
- 终端换行折叠
- 模型名、cwd、快捷键提示等界面噪声

在 `app_server` 模式下，`/approve`、`/enter`、`/up`、`/down` 这类交互式终端控制不适用。代码会提示 approval 由 JSON 模式策略处理，或者说明该控制命令只适用于可视终端会话。`CodexAppServerRunner` 对 app-server 发来的命令执行和文件变更审批请求默认返回 `denied`。

### 兼容策略：`exec_json`

将 `responseSource` 设置为 `exec_json` 后，远程消息会走 `CodexExecRunner`：

```text
codex exec --json --color never --skip-git-repo-check
```

它同样解析结构化 JSON 事件，并支持通过 thread id resume。这个路径适合作为 app-server 不可用时的结构化输出备选。

### 兼容策略：`visual_terminal`

将 `remoteControl.responseSource` 设置为 `visual_terminal` 后，飞书消息会驱动可视终端会话或独立 PTY 会话。

这个模式最接近本地 TUI：

- Electron 模式下可复用当前可视 Codex session
- prompt 通过 bracketed paste 加回车写入 PTY
- `/approve`、`/deny`、`/enter`、`/up`、`/down` 等会转换为终端控制键
- 输出来自 PTY chunk 或渲染层回传的 `visualSnapshot`

该路径有大量清洗逻辑，包括移除 ANSI/OSC 控制序列、过滤 TUI 噪声、识别最终回答 marker、合并 wrapped line、提取 activity。它是 best-effort，因为 Codex TUI 并没有通过终端表面暴露语义化输出流。

### 输出模式

`remoteControl.outputMode` 和 `plugins.feishu.outputMode` 支持：

- `final`：默认，只回传最终回答或最终整理后的内容
- `full`：尽量回传完整清理后输出
- `silent`：不主动发送输出
- `status_only`：保留状态类控制，不发送正文输出

飞书单条文本会按约 3500 字符切分，普通卡片按约 7000 字符切分。streaming card 使用 CardKit 创建卡片实体，再通过 element content update 持续刷新。

## 当前状态判断

从源码和配置看，这个项目当前处于可运行的个人远程控制工具形态：

- Electron TUI、本地 HTTP API、插件系统和飞书 long connection 都已实现。
- 默认远程输出策略已经切到 `app_server`，重点解决早期从终端屏幕抽取回答不稳定的问题。
- `visual_terminal` 仍保留，用于需要直接操控可视 Codex TUI、审批提示或键盘选择的场景。
- `custom_webhook` 飞书模式只适合出站测试和通知，不是完整远程控制入口。
- 安全边界主要依赖本地绑定地址、可选 API token、飞书用户/群 allowlist，以及远程 cwd allowlist。
