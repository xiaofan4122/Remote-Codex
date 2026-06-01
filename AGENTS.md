# AGENTS.md

This project is a remote-friendly shell around the native Codex TUI. The local
Electron terminal is the source of truth for what Codex is doing, and remote
plugins such as Feishu should reflect that state without inventing a separate
workflow.

## Development Principles

- Preserve the native Codex workflow. Remote control should drive the same PTY
  and visible TUI whenever `remoteControl.responseSource` is `visual_terminal`.
- Treat terminal capture as facts, parser output as interpretation, and Feishu
  cards as presentation. Do not mix these layers.
- Prefer state-based confirmation over fixed delays. For example, `/resume`
  restore/exit feedback must wait until the local Codex screen actually leaves
  the resume picker.
- Avoid sending implementation noise to Feishu. Command names, file edits, and
  test runner output are useful in local logs, but remote users usually need
  progress summaries, choices, approvals, final answers, and clear feedback.
- Never rely on one terminal layout. Codex output changes with window size,
  redraws, loading states, slash pages, and version changes.
- Keep card updates idempotent. Repaints, resizes, duplicate Feishu callbacks,
  and repeated button clicks must not create duplicate cards or duplicate
  actions.

## Architecture Notes

- `src/codexSessionManager.js` owns PTY sessions, terminal resizing, visual
  snapshots, styled snapshots, and raw terminal capture.
- `src/rawOutputRecorder.js`, `src/terminalCaptureReplay.js`,
  `src/terminalCaptureExport.js`, and `src/terminalCaptureViewer.js` are the
  reusable capture/replay/debugging tools. Use them when parser behavior is
  unclear.
- `src/remoteSessionController.js` is the state machine between remote messages
  and Codex. It owns command dispatch, native slash-page parsing, stream
  lifecycle, duplicate suppression, approval detection, and session phases.
- `src/plugins/feishu/index.js` should remain mostly transport and presentation:
  receive Feishu events, patch/send cards, build CardKit payloads, and hand
  commands to `RemoteSessionController`.
- Slash pages such as `/status`, `/resume`, and `/permission` are native Codex
  UI surfaces. They need dedicated parsers, dedicated card layouts, and focused
  tests.

## Terminal Capture And Parsing

- Always record enough raw data before changing parsing rules. The capture log
  is a versioned JSONL fact stream containing PTY bytes, resize events, visual
  snapshots, styled snapshots, and session lifecycle events.
- Prefer visual or styled terminal snapshots for page parsing. Raw PTY bytes are
  useful for debugging and replay, but they can contain control sequences,
  redraw fragments, and stale screen content.
- Parser output should be stable under terminal resize. A resize redraw with the
  same semantic content should not send another Feishu card.
- Keep semantic signatures separate from display text. Formatting changes,
  progress bars, and color markers should not accidentally bypass duplicate
  suppression.
- Color metadata may come from styled terminal snapshots. Preserve semantic
  color markers through parser output and let Feishu rendering map them to
  CardKit custom colors.

Useful commands:

```bash
npm run capture:replay -- /path/to/raw-output.jsonl
npm run capture:export-fixture -- /path/to/raw-output.jsonl /tmp/capture.fixture.jsonl
npm run rawlog:replay -- /path/to/raw-output.jsonl
```

## Remote Workflow States

Keep these states explicit when adding behavior:

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

Button handling should respect the current phase. Navigation actions may update
the same card repeatedly. Submit actions such as approval, resume, confirm, and
exit must be locked against duplicate clicks and should update the original
card with visible feedback.

## Feishu Card Guidelines

- Use one card per remote turn whenever possible. Stream updates should patch
  the existing CardKit card; static fallbacks should patch the original action
  card when the action came from a card.
- `/status` cards should not include action buttons. Filter the Codex usage URL
  line and tolerate both status variants: with quota usage, and without quota
  but with enough running information.
- `/resume` cards should show a concise history picker with a highlighted
  current selection. Up/down should update the existing card. Restore/exit
  should show pending feedback first and final success only after Codex leaves
  the picker.
- `/permission` cards should parse exactly the native options when available:
  `Default`, `Auto-review`, and `Full Access`. Show the current `>` selection
  and use up/down/confirm/exit controls.
- Approval cards should list concrete approval options when Codex exposes them,
  and should lock submit actions immediately to prevent repeated allow/deny
  clicks.
- Keep Feishu light-mode and dark-mode colors readable. Use the shared custom
  color tokens in `src/plugins/feishu/index.js` instead of ad hoc colors.

## Testing Expectations

When changing parsing, terminal state, Feishu card behavior, or slash command
handling, add or update focused tests before relying on manual Feishu checks.

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
- Use `buildControlInput` for keyboard controls such as up, down, enter, and
  escape.
- Use `remoteMessageSignature`-style semantic comparison when suppressing
  duplicate output.
- Use CardKit stream helpers in the Feishu plugin instead of direct message
  sends when a turn can be updated in place.

## Logging Guidance

- Runtime logs should explain why a card was sent, patched, ignored, or
  deduplicated.
- Parser/debug logs may include clipped raw text and snapshots, but avoid
  logging secrets. Existing logger redaction should be preserved.
- Add structured event fields for phase, command, action, message ID, session
  ID, and dedupe reason when diagnosing workflow bugs.
- Local raw capture can contain prompts, command output, and file contents. Do
  not commit unredacted captures; export fixtures with the redaction tool first.

## Editing Rules For Agents

- Prefer small, scoped changes that follow the existing modules.
- Do not revert unrelated dirty worktree changes.
- Use `rg` for repository searches.
- Use `apply_patch` for manual edits.
- Keep tests close to the behavior being changed. Parser changes need fixtures
  or deterministic snapshots; card behavior needs card payload assertions;
  workflow changes need state-machine tests.
