# Feishu Plugin

The Feishu plugin supports two modes:

- `long_connection`: enterprise self-built app bot over the official Feishu
  WebSocket SDK. This mode supports receiving remote commands and replying with
  Codex output.
- `custom_webhook`: group custom robot webhook. This mode is for outbound test
  messages and notifications only.

Remote replies drive the visible local Electron terminal by default, so Feishu
input appears in the same native Codex TUI that the user sees locally. Set
`remoteControl.responseSource` to `app_server` only when you prefer structured
Codex app-server events over the visible terminal.
Plain Feishu text is pasted into the Codex composer and confirmed with Tab, so
it uses Codex's queue-message behavior by default.

Streaming cards show visible Codex progress from the TUI, including running
status, command execution, file reads, and edits, then append the final reply.
Card body text uses the same RGBA color palette as the bundled xterm Codex
theme when terminal color metadata is available, and falls back to matching
Codex theme colors for semantic progress states.
Approval prompts are rendered as a waiting-for-confirmation card. The allow,
always-allow, and reject buttons map to the native Codex prompt keys.
When Codex exposes selectable approval options, the card lists the concrete
options and marks the current native selection with `>`. Up/down buttons are
only shown when selectable options are visible; submit buttons immediately
update the original card and are locally locked to avoid duplicate approval
clicks.
Native slash pages such as `/resume`, `/permission`, and `/status` use
dedicated Feishu card button layouts instead of the generic approval controls;
`/resume` shows up, down, resume, and exit controls for the visible
Codex picker. If streaming CardKit updates are unavailable, native slash pages
fall back to a static Feishu card with the same parsed content and controls
instead of plain text.

Advanced config lives under:

```json
{
  "plugins": {
    "feishu": {
      "enabled": false,
      "mode": "long_connection",
      "appId": "",
      "appSecret": "",
      "encryptKey": "",
      "verificationToken": "",
      "defaultChatId": "",
      "customWebhookUrl": "",
      "customWebhookSecret": "",
      "allowedOpenIds": [],
      "allowedChatIds": [],
      "requireMention": false,
      "connectSource": "",
      "connectedAt": "",
      "authorizedOpenId": "",
      "tenantBrand": ""
    }
  }
}
```

The preferred setup path is `Connect Feishu` in the Electron Settings panel.
It calls the SDK `registerApp` flow, opens a Feishu authorization link, stores
the returned app credentials, enables long connection mode, and adds the
authorizing user's open ID to `allowedOpenIds`.

## Bot custom menu

Configure the bot custom menu in the Feishu Developer Console after connecting
the app:

1. Open the app details page, then choose `App capability > Bot`.
2. Edit the bot menu and select the floating menu style.
3. Add these three first-level items with the `Send text message` action:
   - `状态` sends `/status`
   - `历史会话` sends `/resume`
   - `权限模式` sends `/permission`
4. Publish the updated app version.

The documented public APIs and current official SDK do not expose a supported
endpoint for creating or updating this direct-chat bot custom menu. Feishu's
agent-app preset documents an `application:bot.menu:write` scope for
personalized menus, but its callable menu-management API is not published in
the official SDK or bot menu guide yet. The public
`/im/v1/chats/:chat_id/menu_tree` endpoints configure group menus instead;
their actions only support no-op or URL redirects, so they cannot send the
slash commands required here. The floating menu and `Send text message`
action require Feishu client `7.22+` and apply to direct chats with the bot.

Official guide:
https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot

Agent-app preset permissions:
https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview

Supported remote commands:

- `/start [cwd]`
- `/stop`
- `/status`
- `/tail`
- `/approve`
- `/always`
- `/deny`
- `/enter`
- `/up`
- `/down`
- `/help`

Any other text is sent to the current Codex session.

`/stop` interrupts the active task but keeps the local Codex session running.
When the plugin starts, it sends a startup notice to the configured
`defaultChatId` and `allowedChatIds`, with duplicates removed. It ignores
message events created before that startup timestamp.
