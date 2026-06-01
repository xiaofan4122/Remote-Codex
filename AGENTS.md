# AGENTS.md

Remote Codex is an Electron and API shell around the native Codex CLI. The
visible Electron terminal is the source of truth when
`remoteControl.responseSource` is `visual_terminal`, which is the default path
for Feishu remote control. Remote integrations should reflect and control that
same PTY instead of inventing a separate workflow.

## Current Architecture

- `src/main.js` is the Electron main process. It owns window creation, IPC,
  the visible `currentSession`, plugin startup, Feishu one-click registration,
  terminal snapshot intake, the capture-log viewer IPC, and `debug:state`.
- `src/renderer.html`, `src/renderer.js`, and `src/styles.css` implement the
  desktop UI. The toolbar includes project selection, Codex restart, capture
  logs, state debug, and settings. The state debug panel can also be enabled
  from Settings.
- `src/preload.js` is the only renderer bridge. Add renderer-facing APIs here
  instead of reaching around Electron context isolation.
- `src/codexSessionManager.js` owns PTY sessions, terminal resizing, output
  buffers, raw input/output recording hooks, and session status.
- `src/rawOutputRecorder.js`, `src/terminalCaptureReplay.js`,
  `src/terminalCaptureExport.js`, and `src/terminalCaptureViewer.js` are the
  reusable capture, replay, fixture export, and local inspection tools.
- `src/remoteSessionController.js` is the remote workflow state machine. It
  owns remote command dispatch, visual busy detection, native slash-page
  parsing, approval detection, stream lifecycle, duplicate suppression, and
  debug-state construction.
- `src/plugins/feishu/index.js` should stay mostly transport and presentation:
  receive Feishu events and card actions, add receipt reactions, patch/send
  cards, build CardKit payloads, and hand commands to
  `RemoteSessionController`.
- `src/api-server.js`, `src/codexAppServerRunner.js`, and
  `src/codexExecRunner.js` support headless/API or structured-output paths.
  Keep behavior differences explicit; do not assume app-server behavior mirrors
  the visible TUI.

## Development Principles

- Preserve the native Codex workflow. In `visual_terminal` mode, remote control
  should drive the same PTY and visible TUI shown in Electron.
- Treat terminal capture as facts, parser output as interpretation, Feishu
  cards as presentation, and renderer debug panels as inspection. Keep those
  layers separate.
- Prefer state-based confirmation over fixed delays. For example, `/resume`
  restore/exit and `/permission` updates should wait until Codex actually
  leaves the native picker.
- Never rely on one terminal layout. Codex output changes with window size,
  redraws, loading states, slash pages, and version changes.
- Keep card and stream updates idempotent. Repaints, resizes, duplicate Feishu
  callbacks, and repeated button clicks must not create duplicate cards,
  duplicate actions, or duplicate submits.
- Avoid sending implementation noise to Feishu. Local logs and capture viewers
  may show commands, file edits, and test output; remote users usually need
  concise progress, choices, approvals, final answers, and clear feedback.
- Do not let local native slash pages contaminate extracted final answers or
  progress streams. If the visible user opens `/status`, `/resume`, or
  `/permission` locally, trim that page from the current turn output.

## Remote Workflow States

Keep these phases explicit when adding behavior:

- `detached`: no Remote Codex session is attached.
- `idle`: Codex is waiting for input.
- `working`: a normal user task is running.
- `loading_plugins`: Codex is loading MCP/plugins or similar startup work.
- `awaiting_authorization`: Codex is waiting for an approval prompt response.
- `native_status`: `/status` page is active.
- `native_resume`: `/resume` picker is active.
- `native_permissions`: `/permission` or `/permissions` picker is active.
- `native_page`: another native slash page is active.
- `exited`: the underlying Codex session exited.

Busy detection must treat a standalone visible `›` prompt with no active
signals as a strong idle signal, even if the previous submitted prompt has
scrolled out of the viewport. Active signals include `Working`, `Thinking`,
`Running`, spinner lines, and approval questions.

Button handling should respect the current phase. Navigation actions may update
the same card repeatedly. Submit actions such as approval, resume, confirm,
permission mode changes, and exit must be locked against duplicate clicks and
should update the original card with visible feedback.

## Native Slash Pages

Slash pages such as `/status`, `/resume`, and `/permission` are native Codex UI
surfaces. They need dedicated parsers, dedicated card layouts, and focused
tests.

- `/status` cards should not include action buttons. Filter the Codex usage URL
  line and tolerate both status variants: with quota usage, and without quota
  but with enough running information.
- `/resume` cards should show a concise history picker with a highlighted
  current selection. Up/down should update the existing card. Restore/exit
  should show pending feedback first and final success only after Codex leaves
  the picker.
- `/permission` cards should parse exactly the native options when available:
  `Default`, `Auto-review`, and `Full Access`. The direct Feishu buttons send
  `permission_default`, `permission_auto_review`, and
  `permission_full_access`; route those as control actions, not as ordinary
  prompts. For multi-step movement, write individual arrow keys and then Enter
  after a short settling delay.

## Feishu Guidelines

- Use one card per remote turn whenever possible. Stream updates should patch
  the existing CardKit card; static fallbacks should patch the original action
  card when the action came from a card.
- Approval cards should list concrete approval options when Codex exposes them
  and should lock submit actions immediately to prevent repeated allow/deny
  clicks.
- Keep Feishu light-mode and dark-mode colors readable. Use the shared custom
  color tokens in `src/plugins/feishu/index.js` instead of ad hoc colors.
- Acknowledgement reactions are supported for accepted inbound messages through
  the Feishu message reaction API. Defaults live under
  `plugins.feishu.ackReactionEnabled` and `plugins.feishu.ackReactionEmoji`.
  Reaction failures should be logged and must not block command dispatch.
  Custom webhook mode cannot add reactions.
- Feishu message IDs come from receive-message events and card action contexts.
  Preserve them when patching cards, locking actions, and adding reactions.

## Debugging And Capture

- Always record enough raw data before changing parsing rules. The capture log
  is a versioned JSONL fact stream containing PTY bytes, input bytes, visual
  snapshots, styled snapshots, and session lifecycle events. Pure terminal
  control/repaint fragments and resize events are skipped by default; enable
  `remoteControl.rawOutputLogRecordTerminalControls` when low-level ANSI or
  resize replay fidelity is needed.
- Prefer visual or styled terminal snapshots for page parsing. Raw PTY bytes
  are useful for debugging and replay, but they can contain control sequences,
  redraw fragments, and stale screen content.
- Parser output should be stable under terminal resize. A resize redraw with
  the same semantic content should not send another Feishu card.
- Keep semantic signatures separate from display text. Formatting changes,
  progress bars, and color markers should not accidentally bypass duplicate
  suppression.
- Color metadata may come from styled terminal snapshots. Preserve semantic
  color markers through parser output and let Feishu rendering map them to
  CardKit custom colors.
- The Electron toolbar's `State Debug` panel calls `debug:state`. Use it to
  inspect phase, busy, remote state, idle prompt detection, active visual
  signals, approval detection, viewport tail, and output tail while diagnosing
  workflow bugs.
- The Electron toolbar's `Capture Logs` panel reads the same JSONL capture fact
  stream. It is an inspector, not a second parser.
- Use capture replay as a test harness when parser or state detection behavior
  is unclear. `capture:replay` rebuilds xterm state from the JSONL event stream
  and can emit deterministic frame fixtures for algorithm tests.
- `--frames /path/to/frames.jsonl` writes replay frames containing the event
  sequence, terminal size, counters, latest input context, viewport, and
  scrollback. By default frames are captured at terminal snapshots; add
  `--frame-mode all` when a failure depends on an intermediate output, input,
  resize, or exit event.
- `--parser-report /path/to/report.json` runs the current visual and terminal
  parsers against replay frames. Use it to compare parser behavior before and
  after changes, especially for busy/idle detection, native slash pages, final
  answer extraction, and streaming progress.

Useful commands:

```bash
npm run capture:replay -- /path/to/raw-output.jsonl
npm run capture:replay -- /path/to/raw-output.jsonl --frames /tmp/frames.jsonl
npm run capture:replay -- /path/to/raw-output.jsonl --parser-report /tmp/parser-report.json
npm run capture:replay -- /path/to/raw-output.jsonl --frames /tmp/frames.jsonl --frame-mode all
npm run capture:export-fixture -- /path/to/raw-output.jsonl /tmp/capture.fixture.jsonl
npm run rawlog:replay -- /path/to/raw-output.jsonl
npm run corpus:cleaning
npm run corpus:replay -- /path/to/corpus.jsonl
```

Local raw capture can contain prompts, command output, file contents, and user
messages. Do not commit unredacted captures; export fixtures with the redaction
tool first.

For tests that must reproduce the exact terminal behavior, enable
`remoteControl.rawOutputLogRecordTerminalControls` before collecting the
capture, either in Settings or with
`REMOTE_CODEX_RAW_OUTPUT_LOG_RECORD_TERMINAL_CONTROLS=1`. Compact logs are
useful for daily inspection, but full replay needs control sequences and resize
events.

## Configuration Notes

- Defaults live in `src/config.js`; examples live in `config.example.json`.
- Runtime config is loaded from environment, then config file, then defaults.
  The default file is `~/.remote-codex.json`; legacy `CODEX_SHELL_CONFIG` and
  `~/.codex-electron-shell.json` are still supported.
- Electron Settings intentionally cover common controls. Advanced deployment
  options can remain config-file or environment-only.
- If you add a renderer-visible setting, update `src/config.js`,
  `src/renderer.html`, `src/renderer.js`, and any relevant documentation.
- An already-open Electron window will not hot-reload changed HTML. Restart the
  app before manually checking newly added UI entry points.

## Testing Expectations

When changing parsing, terminal state, Feishu card behavior, slash command
handling, capture/debug tools, or renderer workflow controls, add or update
focused tests before relying on manual Feishu checks.

Core checks:

```bash
npm run test:remote-output-parser
npm run test:native-slash-pages
npm run test:remote-workflow-state
npm run test:permission-card-actions
npm run test:terminal-capture
npm run smoke:remote-streaming
npm run smoke:feishu-rich-text
git diff --check
```

Also run targeted syntax checks for touched files, for example:

```bash
node -c src/main.js
node -c src/renderer.js
node -c src/remoteSessionController.js
node -c src/plugins/feishu/index.js
```

Use `npm run smoke:native-slash -- /status`, `/resume`, or `/permission` when a
real Codex TUI smoke test is needed. Codex may need startup time before native
slash commands respond, so tests and manual checks should allow for loading
states.

## Reusable Helpers

- Use `formatNativeSlashOutput` for native slash-page extraction.
- Use `isCompleteStatusSlashOutput` before finalizing `/status` streams or
  sending static `/status` fallbacks.
- Use `buildNativeSlashInput` and `writeNativeSlashCommand` to send native slash
  commands into the TUI.
- Use `buildControlInput`, `buildNativeControlInput`, and related permission
  helpers for keyboard controls and direct permission-mode buttons.
- Use `remoteMessageSignature`-style semantic comparison when suppressing
  duplicate output.
- Use CardKit stream helpers in the Feishu plugin instead of direct message
  sends when a turn can be updated in place.
- Use `RemoteSessionController.buildDebugState()` for local state inspection
  instead of duplicating detection logic in the renderer.

## Logging Guidance

- Runtime logs should explain why a card was sent, patched, ignored,
  deduplicated, or why a message reaction failed.
- Raw capture should avoid low-signal terminal control noise by default to keep
  log files small. The settings checkbox `Record terminal control events`
  restores full capture for deep terminal debugging.
- Parser/debug logs may include clipped raw text and snapshots, but avoid
  logging secrets. Existing logger redaction should be preserved.
- Add structured event fields for phase, command, action, message ID, session
  ID, and dedupe reason when diagnosing workflow bugs.

## Editing Rules For Agents

- Prefer small, scoped changes that follow existing modules.
- Do not revert unrelated dirty worktree changes.
- Use `rg` for repository searches.
- Use `apply_patch` for manual edits.
- Keep tests close to the behavior being changed. Parser changes need fixtures
  or deterministic snapshots; card behavior needs card payload assertions;
  workflow changes need state-machine tests; renderer controls need at least
  syntax checks and, where practical, state/controller tests behind their IPC.
