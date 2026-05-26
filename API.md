# Remote Codex API

This document describes the local headless API for controlling Codex CLI
sessions without opening the Electron window.

The API is intended for personal local integrations, such as another desktop
app, a web UI running on localhost, or an automation agent.

## Start The Server

```bash
cd /path/to/remote-codex
npm run api
```

Default base URL:

```text
http://127.0.0.1:4317
```

The server starts Codex by running `codex` from `PATH`.

## Configuration

Environment variables:

```bash
CODEX_API_HOST=127.0.0.1
CODEX_API_PORT=4317
CODEX_API_TOKEN=change-me
CODEX_WORKDIR=/path/to/default/project
CODEX_COMMAND=/full/path/to/codex
CODEX_OUTPUT_BUFFER_CHUNKS=5000
REMOTE_CODEX_CONFIG=/path/to/config.json
FEISHU_ENABLED=1
FEISHU_MODE=long_connection
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

Notes:

- `CODEX_API_HOST` defaults to `127.0.0.1`.
- Do not bind to `0.0.0.0` unless you understand the security risk.
- `CODEX_API_TOKEN` is optional. If set, every request must include an
  `Authorization` header.
- `CODEX_COMMAND` changes the Codex executable path used by default.
- The API does not allow clients to choose arbitrary commands unless the server
  is started with `CODEX_API_ALLOW_COMMAND=1`. Keep that disabled for normal use.
- File-based configuration is loaded from `REMOTE_CODEX_CONFIG` or
  `~/.remote-codex.json`. Legacy `CODEX_SHELL_CONFIG` and
  `~/.codex-electron-shell.json` are still supported. Environment variables
  override the config file.

Authenticated request header:

```text
Authorization: Bearer change-me
```

## Concepts

A session is one running PTY process. By default, each session runs:

```text
codex
```

Each session has:

- `id`: session identifier.
- `cwd`: working directory.
- `cols`, `rows`: terminal size.
- `cursor`: latest output cursor.
- `exited`: whether the process has exited.

Output is returned as ordered chunks. Clients should keep the latest `cursor`
and request only newer chunks.

Integration plugins are loaded from `src/plugins/`. The built-in Feishu plugin
can receive remote messages through Feishu long connection mode and forward them
to Codex through the same session manager used by this API.

The Feishu plugin can also register an app through the official SDK one-click
flow. The API returns an authorization URL and QR image data URL; after the user
authorizes in Feishu, the server saves the returned credentials and restarts the
plugin.

## Endpoints

### Health

```http
GET /health
```

Example:

```bash
curl http://127.0.0.1:4317/health
```

Response:

```json
{
  "ok": true,
  "defaultCommand": "codex",
  "defaultCwd": "/home/ubuntu",
  "sessions": 0
}
```

### List Sessions

```http
GET /sessions
```

Example:

```bash
curl http://127.0.0.1:4317/sessions
```

Response:

```json
{
  "sessions": [
    {
      "id": "SESSION_ID",
      "command": "codex",
      "args": [],
      "cwd": "/path/to/project",
      "cols": 120,
      "rows": 34,
      "createdAt": "2026-05-03T12:00:00.000Z",
      "exitedAt": null,
      "exited": false,
      "exit": null,
      "cursor": 3
    }
  ]
}
```

### List Plugins

```http
GET /plugins
```

Example:

```bash
curl http://127.0.0.1:4317/plugins
```

Response:

```json
{
  "plugins": [
    {
      "id": "feishu",
      "name": "Feishu",
      "description": "Receive remote Codex commands and send notifications through Feishu.",
      "modes": ["long_connection", "custom_webhook"],
      "enabled": false,
      "running": false,
      "status": null
    }
  ]
}
```

### Invoke Plugin Action

```http
POST /plugins/:id/actions/:action
Content-Type: application/json
```

The Feishu plugin currently supports `test`:

```bash
curl -X POST http://127.0.0.1:4317/plugins/feishu/actions/test \
  -H 'content-type: application/json' \
  -d '{"text":"Remote Codex test","receiveId":"oc_xxx","receiveIdType":"chat_id"}'
```

Response:

```json
{
  "ok": true
}
```

### Connect Feishu

Start one-click Feishu app registration:

```http
POST /plugins/feishu/connect
Content-Type: application/json
```

Example:

```bash
curl -X POST http://127.0.0.1:4317/plugins/feishu/connect \
  -H 'content-type: application/json' \
  -d '{}'
```

Initial response:

```json
{
  "status": "starting",
  "message": "Preparing Feishu authorization..."
}
```

Poll status:

```http
GET /plugins/feishu/connect
```

When the authorization link is ready, the response includes:

```json
{
  "status": "waiting",
  "url": "https://...",
  "qrDataUrl": "data:image/png;base64,...",
  "expireAt": "2026-05-25T12:00:00.000Z"
}
```

Open `url` or render `qrDataUrl`. After authorization succeeds, status becomes:

```json
{
  "status": "complete",
  "message": "Feishu connected.",
  "appId": "cli_xxx",
  "userOpenId": "ou_xxx",
  "configPath": "/home/user/.remote-codex.json"
}
```

Cancel the current registration:

```http
DELETE /plugins/feishu/connect
```

### Create Session

```http
POST /sessions
Content-Type: application/json
```

Request body:

```json
{
  "cwd": "/path/to/project",
  "cols": 120,
  "rows": 34
}
```

Fields:

- `cwd`: optional. Working directory for Codex.
- `cols`: optional. Initial terminal columns. Defaults to `120`.
- `rows`: optional. Initial terminal rows. Defaults to `34`.
- `id`: optional. Custom session id.

Example:

```bash
curl -X POST http://127.0.0.1:4317/sessions \
  -H 'content-type: application/json' \
  -d '{"cwd":"/path/to/project","cols":120,"rows":34}'
```

Response:

```json
{
  "session": {
    "id": "SESSION_ID",
    "command": "codex",
    "args": [],
    "cwd": "/path/to/project",
    "cols": 120,
    "rows": 34,
    "createdAt": "2026-05-03T12:00:00.000Z",
    "exitedAt": null,
    "exited": false,
    "exit": null,
    "cursor": 0
  }
}
```

### Get Session

```http
GET /sessions/:id
```

Example:

```bash
curl http://127.0.0.1:4317/sessions/SESSION_ID
```

Response:

```json
{
  "session": {
    "id": "SESSION_ID",
    "command": "codex",
    "args": [],
    "cwd": "/path/to/project",
    "cols": 120,
    "rows": 34,
    "createdAt": "2026-05-03T12:00:00.000Z",
    "exitedAt": null,
    "exited": false,
    "exit": null,
    "cursor": 0
  }
}
```

### Send Input

```http
POST /sessions/:id/input
Content-Type: application/json
```

Request body:

```json
{
  "data": "your input\n"
}
```

Important:

- Include `\n` when you want to press Enter.
- For interactive terminal control, send raw terminal input strings.

Example:

```bash
curl -X POST http://127.0.0.1:4317/sessions/SESSION_ID/input \
  -H 'content-type: application/json' \
  -d '{"data":"hello\n"}'
```

Response:

```json
{
  "ok": true
}
```

### Read Output

```http
GET /sessions/:id/output?cursor=0
```

Example:

```bash
curl 'http://127.0.0.1:4317/sessions/SESSION_ID/output?cursor=0'
```

Response:

```json
{
  "cursor": 2,
  "chunks": [
    {
      "cursor": 1,
      "data": "Codex output...",
      "at": "2026-05-03T12:00:01.000Z"
    },
    {
      "cursor": 2,
      "data": "More output...",
      "at": "2026-05-03T12:00:02.000Z"
    }
  ],
  "exited": false,
  "exit": null
}
```

Client polling pattern:

1. Start with `cursor=0`.
2. Append all returned `chunks[*].data` to your terminal or log.
3. Store the response `cursor`.
4. Next request uses that cursor.

Example loop logic:

```js
let cursor = 0;

async function poll(sessionId) {
  const res = await fetch(
    `http://127.0.0.1:4317/sessions/${sessionId}/output?cursor=${cursor}`
  );
  const body = await res.json();
  cursor = body.cursor;
  for (const chunk of body.chunks) {
    process.stdout.write(chunk.data);
  }
}
```

### Resize Session

```http
POST /sessions/:id/resize
Content-Type: application/json
```

Request body:

```json
{
  "cols": 100,
  "rows": 30
}
```

Example:

```bash
curl -X POST http://127.0.0.1:4317/sessions/SESSION_ID/resize \
  -H 'content-type: application/json' \
  -d '{"cols":100,"rows":30}'
```

Response:

```json
{
  "session": {
    "id": "SESSION_ID",
    "cols": 100,
    "rows": 30,
    "exited": false,
    "cursor": 2
  }
}
```

The real response includes the full session object.

### Stop Session

```http
DELETE /sessions/:id
```

Example:

```bash
curl -X DELETE http://127.0.0.1:4317/sessions/SESSION_ID
```

Response:

```json
{
  "session": {
    "id": "SESSION_ID",
    "exited": false,
    "cursor": 2
  }
}
```

The real response includes the full session object. The session is removed from
the manager immediately after sending the kill signal.

## Minimal JavaScript Client

```js
const baseUrl = 'http://127.0.0.1:4317';

async function createSession(cwd) {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, cols: 120, rows: 34 })
  });
  const body = await res.json();
  return body.session.id;
}

async function sendInput(sessionId, data) {
  await fetch(`${baseUrl}/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data })
  });
}

async function readOutput(sessionId, cursor = 0) {
  const res = await fetch(`${baseUrl}/sessions/${sessionId}/output?cursor=${cursor}`);
  return res.json();
}

const sessionId = await createSession('/path/to/project');
await sendInput(sessionId, 'hello\n');
const output = await readOutput(sessionId, 0);
console.log(output);
```

## Error Responses

Errors are JSON:

```json
{
  "error": "Unknown session: SESSION_ID"
}
```

Common status codes:

- `400`: bad input.
- `401`: missing or invalid token.
- `404`: session or route not found.
- `500`: server or PTY error.

## Security Notes

- Keep the server bound to `127.0.0.1` for personal use.
- Set `CODEX_API_TOKEN` if another local app or browser page will call it.
- Do not expose this API to a LAN or the public internet.
- The API controls an interactive shell-like process. Treat it as trusted local
  automation only.
- Remote plugins should keep `allowedOpenIds`, `allowedChatIds`, and
  `codex.allowedWorkdirs` restricted. Without `allowedWorkdirs`, remote users can
  only start Codex in the configured default working directory.
