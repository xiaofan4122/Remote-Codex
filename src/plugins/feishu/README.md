# Feishu Plugin

The Feishu plugin supports two modes:

- `long_connection`: enterprise self-built app bot over the official Feishu
  WebSocket SDK. This mode supports receiving remote commands and replying with
  Codex output.
- `custom_webhook`: group custom robot webhook. This mode is for outbound test
  messages and notifications only.

Remote input drives the visible local Electron terminal by default, so Feishu
input appears in the same native Codex TUI that the user sees locally. Normal
reply text comes from that session's rollout JSONL; terminal text is used only
for native slash pages, approvals, and local inspection. Set `responseSource`
to `app_server` or `exec_json` only for an independent headless session.
Plain Feishu text is pasted into the Codex composer and confirmed with Tab, so
it uses Codex's queue-message behavior by default.

Single-card CardKit output is the default: rollout commentary events accumulate
in one blue processing card and the rollout final-answer event replaces its
body before the same card turns green. Binding and process failures turn the
same card red. Set `singleCardOutput` to `false` only for the legacy segmented
card mode.
The bundled `remote-codex-send-files` skill can declare generated workspace
files in a structured final answer. Remote Codex removes the declaration from
the card, validates that the real file remains inside the active Codex working
directory, and sends it as a Feishu file message. This is available only in
`long_connection` mode. Files must be non-empty regular files; defaults limit a
turn to five files and each file to Feishu's 30 MB upload limit. Validation or
upload failures turn the original completion card orange and add the reason.
Final-answer LaTeX is rendered locally before the completed card is sent.
MathJax produces formula SVG, resvg-WASM rasterizes it to a fixed-width PNG,
and the plugin uploads that PNG for an `image_key`. Block formulas become image
components. A short line containing inline math is composed from local text
font segments and formula images on one canvas, so surrounding text is not
lost. Custom webhooks and failed renders use readable code-block fallbacks.
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
      "singleCardOutput": true,
      "streaming": true,
      "segmentedOutput": false,
      "fileTransferEnabled": true,
      "fileTransferMaxBytes": 31457280,
      "fileTransferMaxFiles": 5,
      "latexRenderingEnabled": true,
      "latexMaxFormulas": 64,
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
