# Remote Codex

Remote-friendly Codex CLI monitor and controller.

## Setup

```bash
npm install
npm start
```

The app expects `codex` to be available on `PATH`. Run `codex --login` in your normal terminal first if you have not logged in.
Remote Codex starts Codex with `--no-alt-screen` by default so the desktop
terminal keeps a usable scrollback history instead of losing content to TUI
screen redraws.

## App Launcher

Install user-level launchers:

```bash
npm run install:launchers
```

This installs:

- `remote-codex`: opens the Electron app.
- `remote-codex-api`: starts the headless API server.
- `Remote Codex`: desktop launcher entry.

After installing, open the app from your terminal with:

```bash
remote-codex
```

Resume an existing Codex TUI session at startup:

```bash
remote-codex --resume --last
remote-codex --resume SESSION_ID
remote-codex resume --last
```

Environment-variable form:

```bash
REMOTE_CODEX_RESUME=last remote-codex
REMOTE_CODEX_RESUME=SESSION_ID REMOTE_CODEX_RESUME_PROMPT="continue" remote-codex
```

When launched from a terminal, Remote Codex uses that terminal's current
directory as the default Codex working directory unless you saved another
default folder in Settings or set `CODEX_WORKDIR`.

Or start the background API with:

```bash
remote-codex-api
```

The installer writes launchers to `~/.local/bin`, creates a desktop file under
`~/.local/share/applications`, and makes sure `~/.local/bin` is available from
both zsh and bash. If you move this project directory, run the installer again.

## Configuration

Copy the example config when you want file-based settings:

```bash
cp config.example.json config.json
REMOTE_CODEX_CONFIG=./config.json npm start
```

If `REMOTE_CODEX_CONFIG` is not set, the app reads and writes:

```text
~/.remote-codex.json
```

Legacy `CODEX_SHELL_CONFIG` and `~/.codex-electron-shell.json` are still read
for compatibility.

Configuration priority:

```text
environment variables > config file > defaults
```

Optional environment variables:

```bash
REMOTE_CODEX_CONFIG=/path/to/config.json
CODEX_WORKDIR=/path/to/project npm start
CODEX_COMMAND=/full/path/to/codex npm start
```

The Electron Settings panel intentionally stays small: default project folder
and Feishu connection. Advanced deployment options remain available through the
config file and environment variables.

## Logs

Remote Codex writes runtime logs to:

```text
~/.local/state/remote-codex/remote-codex.log
```

The log includes plugin startup, Feishu inbound messages, remote commands,
session starts/exits, and cleaned reply text. Secrets and tokens are redacted.

## Integration Plugins

Integration plugins live under `src/plugins/`. Each plugin implements the same
small runtime interface:

```js
async start() {}
async stop() {}
async invoke(action, payload) {}
getStatus() {}
```

Remote message plugins should call the shared remote controller instead of
directly writing to the PTY. See `src/plugins/README.md`.

### Feishu

The built-in Feishu plugin supports:

- `long_connection`: enterprise self-built app bot using Feishu's official
  WebSocket SDK. This supports sending commands to Codex and receiving output.
- `custom_webhook`: Feishu group custom robot webhook. This is useful for
  outbound notifications and testing, but not for receiving commands.

The easiest setup path is:

1. Open `Settings`.
2. Click `Connect Feishu`.
3. Scan or open the Feishu authorization link.
4. Add the created bot to the target chat.

After authorization, the app stores the returned App ID/App Secret, enables
long connection mode, and adds the authorizing user's Open ID to the allowlist.

The Electron window shows the native Codex TUI, so slash commands, approvals,
keyboard shortcuts, model switching, and other TUI behavior continue to come
from Codex itself.

Feishu replies default to `visual_terminal`, so remote messages drive the same
native Codex TUI shown in the Electron window. This preserves slash commands,
approval prompts, keyboard navigation, and model switching behavior.
Plain remote text is pasted into the Codex composer and confirmed with Tab, so
it follows Codex's default queue-message behavior instead of forcing an
immediate Enter submit.
When Feishu streaming cards are available, the card is updated with visible
Codex progress such as `Working`, command runs, file reads, and edits before
the final reply is shown. Cards use semantic colors for progress, approvals,
commands, file changes, warnings, and final replies; the local Electron window
remains the source of the native terminal rendering.

If you prefer structured Codex app-server events instead of the visible
terminal, set `remoteControl.responseSource` to `app_server`. That path avoids
terminal text extraction, but it does not mirror the visible TUI session.

For cleaning-rule debugging, enable an opt-in corpus:

```bash
REMOTE_CODEX_CAPTURE_CLEANING=1 remote-codex
```

Samples are written to `~/.local/state/remote-codex/cleaning-corpus.jsonl` by
default. Use `npm run corpus:cleaning` to extract historical log samples and
`npm run corpus:replay -- /path/to/corpus.jsonl` to replay the current cleaning
rules against captured raw/snapshot output.

For temporary full PTY logging during parser work, enable the raw output log:

```bash
REMOTE_CODEX_RAW_OUTPUT_LOG=1 remote-codex
```

Raw events are written to `~/.local/state/remote-codex/raw-output.jsonl` by
default. The JSONL stores input/output/exit events, session metadata, a readable
preview, and base64-encoded PTY bytes. Use
`npm run rawlog:replay -- /path/to/raw-output.jsonl` to replay the current text
parser against long-running captures. This can contain prompts, command output,
and file contents, so keep it disabled unless you are collecting parser samples.
The same raw output log can be enabled from Settings with the checkbox next to
`Open Log`.
If Codex opens an approval prompt in visual terminal mode, the streaming card
switches to a waiting-for-confirmation view with the command, reason, and
visible options. Use the card buttons or send `/approve`, `/always`, or
`/deny`. For selection-style prompts, `/up`, `/down`, and `/enter` pass through
the matching terminal keys.

For advanced/manual Feishu setup, configure these in the config file:

- `plugins.feishu.enabled`
- `plugins.feishu.mode`
- `plugins.feishu.appId`
- `plugins.feishu.appSecret`
- `plugins.feishu.allowedOpenIds`
- `plugins.feishu.allowedChatIds`

Remote commands:

```text
/start [cwd]
/stop
/status
/tail
/approve
/always
/deny
/enter
/up
/down
/help
```

Any other message is sent to the current Codex session.

## Headless API

Start the local API server without opening the Electron window:

```bash
npm run api
```

By default it listens on `http://127.0.0.1:4317` and starts `codex` from your
`PATH`.

Useful environment variables:

```bash
CODEX_API_PORT=4317
CODEX_API_HOST=127.0.0.1
CODEX_API_TOKEN=change-me
CODEX_WORKDIR=/path/to/project
CODEX_COMMAND=/full/path/to/codex
FEISHU_ENABLED=1
FEISHU_MODE=long_connection
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

Headless Feishu connect flow:

```bash
curl -X POST http://127.0.0.1:4317/plugins/feishu/connect
curl http://127.0.0.1:4317/plugins/feishu/connect
```

Open the returned `url` or render `qrDataUrl`, then poll the status endpoint
until it returns `complete`.

If `CODEX_API_TOKEN` is set, every request needs:

```text
Authorization: Bearer change-me
```

### API

Health check:

```bash
curl http://127.0.0.1:4317/health
```

Create a Codex session:

```bash
curl -X POST http://127.0.0.1:4317/sessions \
  -H 'content-type: application/json' \
  -d '{"cwd":"/path/to/project","cols":120,"rows":34}'
```

Send input to a session. Include newline when you want to press Enter:

```bash
curl -X POST http://127.0.0.1:4317/sessions/SESSION_ID/input \
  -H 'content-type: application/json' \
  -d '{"data":"help\n"}'
```

Read output after a cursor:

```bash
curl 'http://127.0.0.1:4317/sessions/SESSION_ID/output?cursor=0'
```

Resize:

```bash
curl -X POST http://127.0.0.1:4317/sessions/SESSION_ID/resize \
  -H 'content-type: application/json' \
  -d '{"cols":100,"rows":30}'
```

Stop:

```bash
curl -X DELETE http://127.0.0.1:4317/sessions/SESSION_ID
```

See [API.md](./API.md) for the complete API reference.
