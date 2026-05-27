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
Cards use semantic colors to approximate the native terminal: running status
and approvals are orange, command execution is blue, file changes and final
replies are green, warnings are orange, and errors are red.
Approval prompts are rendered as a waiting-for-confirmation card. The `Yes`,
`Always`, and `No` buttons map to the native Codex prompt keys.

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
