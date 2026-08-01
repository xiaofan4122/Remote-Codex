<p align="center">
  中文 | <a href="./README_EN.md">English</a>
</p>

# Remote Codex

<p align="center">
  <img src="docs/assets/remote-codex-logo.png" alt="Remote Codex" width="600" />
</p>

Remote Codex 是原生 Codex CLI 的 Linux 桌面外壳，同时支持通过飞书远程操控。

> **仅支持 Linux。** 发行版支持 `x86_64` 和 `arm64` 架构。
> 使用 Remote Codex 前，请先安装原生 `codex` 命令并完成登录。

## 为什么选择 Remote Codex？

- **只做外壳，不替代原生 Codex。** TUI、命令、权限和会话仍由原生 Codex CLI 提供。
- **随时随地开发。** 从飞书发送任务，在一张持续更新的卡片中查看进度，告别零散消息刷屏。
- **快速连接飞书。** 在桌面端设置中通过内置授权流程即可连接机器人。
- **技术内容清晰易读。** 自动识别并在本地渲染 LaTeX，也支持文本与行内公式混排的短行。
- **内置文件传输。** 报告、补丁、图片及其他工作区文件可直接返回当前飞书会话。

### 保留原生 Codex 工作流

<p align="center">
  <img
    src="docs/assets/demos/native-codex-shell.gif"
    alt="在 Remote Codex 中运行原生 Codex TUI"
    width="900"
  />
</p>

### 一张卡片，持续更新

远程任务的进度、操作和最终回答都会呈现在同一张实时更新的卡片中。

<p align="center">
  <img
    src="docs/assets/demos/single-card-updates.gif"
    alt="Remote Codex 持续更新同一张飞书卡片"
    width="900"
  />
</p>

### 自动渲染 LaTeX

公式区域会在本地自动识别并渲染，再以清晰的图片嵌入飞书卡片。

<p align="center">
  <img
    src="docs/assets/demos/latex-rendering.gif"
    alt="Remote Codex 在飞书卡片中渲染 LaTeX 公式"
    width="900"
  />
</p>

### 远程使用原生 Codex 功能

部分原生 Codex 页面会映射为可交互的飞书卡片。卡片操作仍然驱动同一个可见的
Codex TUI，不会替代或重新实现底层工作流。

<table>
  <tr>
    <th>权限模式</th>
    <th>恢复会话</th>
    <th>会话状态</th>
  </tr>
  <tr>
    <td><img src="docs/assets/demos/native-permission.gif" alt="从飞书切换原生 Codex 权限模式" width="260" /></td>
    <td><img src="docs/assets/demos/native-resume.gif" alt="从飞书恢复原生 Codex 会话" width="260" /></td>
    <td><img src="docs/assets/demos/native-status.gif" alt="从飞书查看原生 Codex 会话状态" width="260" /></td>
  </tr>
  <tr>
    <td align="center"><code>/permission</code></td>
    <td align="center"><code>/resume</code></td>
    <td align="center"><code>/status</code></td>
  </tr>
</table>

## 安装

环境要求：

- 使用 glibc 2.31 或更高版本的 Linux 发行版，例如 Ubuntu 20.04 及以上版本。
- `PATH` 中已存在原生 `codex` 命令，并且已完成登录。

### Ubuntu 和 Debian

根据 `dpkg --print-architecture` 的结果下载对应软件包：

| 架构 | 下载 |
| --- | --- |
| `amd64` | [remote-codex-linux-amd64.deb](https://github.com/xiaofan4122/Remote-Codex/releases/latest/download/remote-codex-linux-amd64.deb) |
| `arm64` | [remote-codex-linux-arm64.deb](https://github.com/xiaofan4122/Remote-Codex/releases/latest/download/remote-codex-linux-arm64.deb) |

安装下载的软件包；ARM64 设备请替换为对应文件名：

```bash
sudo apt install ./remote-codex-linux-amd64.deb
```

在项目目录中启动 Remote Codex：

```bash
cd /path/to/project
remote-codex
```

可在 **设置 → 软件更新** 中检查并安装更新。

卸载：

```bash
sudo apt remove remote-codex
```

所有软件包可在 [GitHub Releases 页面](https://github.com/xiaofan4122/Remote-Codex/releases/latest)查看。

## 连接飞书

1. 打开 Remote Codex 的 **设置**。
2. 选择 **连接飞书**。
3. 打开或扫描授权链接。
4. 将创建好的机器人加入需要使用的会话。

来自飞书的消息会驱动 Electron 中同一个可见的 Codex 会话。常用远程控制命令包括
`/status`、`/resume`、`/permission` 和 `/stop`。`/delete`、`/logout`、`/exit`
等具有破坏性的原生命令无法通过远程执行。

默认情况下，在桌面客户端中输入的任务只保留在本地。可在设置中启用
**将新桌面任务发送到飞书**，将新提交的提示词及其运行回复转发到飞书。即使关闭此选项，
桌面任务仍然可以使用文件传输功能。

Remote Codex 支持同时打开多个桌面窗口。多开时，工具栏会显示
**将此窗口连接到飞书**。最新打开的窗口默认被选中；选择其他窗口后，唯一的飞书连接会
转移到该窗口及其 Codex 会话。

## 工作原理

```text
飞书输入 ──→ RemoteSessionController ──→ 可见的 Codex PTY
                                                  │
Codex rollout JSONL ──→ 语义事件 ──→ 一张飞书卡片
```

远程输入控制的是 Electron 终端使用的同一个原生 PTY。正常进度和最终回答来自当前任务
对应的 Codex rollout JSONL，而非对终端画面进行文本抓取。终端快照只用于 `/resume`、
`/permission` 等原生页面和授权提示。

## 从源码开发

开发环境需要 Node.js 22.12 或更高版本：

```bash
npm ci
npm start
```

运行完整测试和语法检查：

```bash
npm run check
```

使用 `npm run api` 可启动可选的本地无头 API。

## 配置与文档

运行时配置保存在 `~/.remote-codex.json`。支持的配置结构请参阅
[config.example.json](./config.example.json)。

- [项目架构](./ARCHITECTURE.md)
- [飞书集成](./src/plugins/feishu/README.md)
- [无头 API](./API.md)
- [贡献与发布](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)

## 许可证

[MIT](./LICENSE)
