# AGENTS.md

Remote Codex is an Electron and API shell around the native Codex CLI. Feishu
still drives the same visible PTY as Electron, but normal reply text comes from
Codex's semantic rollout files under `~/.codex/sessions/**/rollout-*.jsonl`.
The default `remoteControl.responseSource` is `rollout_jsonl`. Terminal text is
never a fallback source for normal progress or final answers.

## Current Architecture

- `src/main.js` is the Electron main process. It owns window creation, IPC,
  the visible `currentSession`, plugin startup, Feishu one-click registration,
  terminal snapshot intake, and opt-in native-TUI diagnostic capture.
- `src/renderer.html`, `src/renderer.js`, and `src/styles.css` implement the
  desktop UI. The toolbar includes project selection, Codex restart, and
  settings. Feishu settings include LaTeX rendering and formula-count controls.
- `src/preload.js` is the only renderer bridge. Add renderer-facing APIs here
  instead of reaching around Electron context isolation.
- `src/codexSessionManager.js` owns PTY sessions, terminal resizing, output
  buffers, raw input/output recording hooks, and session status.
- `src/codexRolloutReader.js` binds each submitted prompt through
  `~/.codex/history.jsonl`, finds the matching rollout file, tails only the
  current task, and emits ordered `progress`, `final`, and `turn_complete`
  events. It ignores duplicate `response_item` records and all tool output.
- `src/rawOutputRecorder.js`, `src/terminalCaptureReplay.js`, and
  `src/terminalCaptureExport.js` are developer-only native-TUI capture, replay,
  and fixture-export tools. Production capture is disabled unless
  `REMOTE_CODEX_DIAGNOSTIC_CAPTURE=1` is present at startup.
- `src/remoteSessionController.js` is the remote workflow state machine. It
  owns remote command dispatch, visual busy detection, native slash-page
  parsing, approval detection, rollout event delivery, stream lifecycle,
  and duplicate suppression.
- `src/latexRenderer.js` owns block/inline LaTeX recognition and lazy local
  MathJax + resvg-WASM rendering. Feishu transport owns image upload and
  `image_key` caching; do not push network behavior into the renderer.
- `src/remoteOutputCleanup.js` contains pure terminal-output cleanup helpers:
  color-marker stripping, `Working` repaint-fragment detection, trailing repaint
  cleanup, and file-stat line recognition. These helpers are for native TUI
  inspection and semantic signatures, not normal answer extraction.
- `src/remoteFileDelivery.js` owns exact final-answer file directive parsing and
  workspace-boundary, regular-file, non-empty, and size validation. Keep file
  upload transport out of this pure module.
- `src/remoteControlInput.js` contains pure remote-control input mappings:
  bracketed-paste submission, slash passthrough, approval/navigation key bytes,
  and permission-mode action metadata. Keep page-state parsing in
  `remoteSessionController.js`.
- `src/nativeSlashCommands.js` is the native command registry. It classifies
  each supported Codex slash command as picker, viewer, report, immediate,
  rollout task, session command, destructive command, or Remote Codex naming
  conflict. Keep routing, aliases, and action layouts driven by this registry.
- `src/visualSessionState.js` contains pure visual-terminal active/idle/settled
  detection helpers. Keep this logic small and directly tested instead of
  growing `remoteSessionController.js`.
- `src/plugins/feishu/index.js` should stay mostly transport and presentation:
  receive Feishu events and card actions, add receipt reactions, patch/send
  cards, and hand commands to `RemoteSessionController`.
- `src/plugins/feishu/cardActions.js`, `cardBuilders.js`, `cardMarkdown.js`,
  `messageContent.js`, and `replyStream.js` own Feishu action semantics, CardKit
  payload construction, markdown/color formatting, inbound content extraction,
  and streaming card lifecycle respectively. Do not push those responsibilities
  back into `src/plugins/feishu/index.js`.
- `src/api-server.js`, `src/codexAppServerRunner.js`, and
  `src/codexExecRunner.js` support headless/API or structured-output paths.
  Keep behavior differences explicit; do not assume app-server behavior mirrors
  the visible TUI.
- `src/appUpdateManager.js` owns the renderer-facing update state machine and
  selects the packaged Linux update backend. Debian packages use
  `electron-updater`; managed user-local archives use `src/linuxTarUpdater.js`
  to download the complete release, verify SHA-256, and reuse `install.sh`'s
  atomic version-directory switch. Development and unknown portable layouts
  must remain non-installing.

## Development Principles

- Preserve the native Codex workflow: remote input and controls drive the same
  PTY and visible TUI shown in Electron, while normal output is observed from
  that session's rollout JSONL.
- Treat rollout events as normal-output facts, terminal capture as native-UI
  facts, controller state as interpretation, Feishu cards as presentation, and
  renderer debug panels as inspection. Keep those layers separate.
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
- Do not parse normal answers from PTY bytes, terminal scrollback, visual
  snapshots, prompt markers, idle detection, or repaint cleanup. If rollout
  binding fails, report the failure and keep terminal fallback disabled.
- Do not reject a normal remote message merely because a task is active. Write
  it to the native Codex queue immediately, start a dedicated rollout observer
  before that write, and activate its Feishu card after the previous card has
  closed. Preserve ordering and distinguish repeated identical queued prompts.
  Approval prompts and native picker pages remain blocking interaction states.

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

Busy detection must treat a visible `›` prompt with no active signals as a
strong idle signal, even if the previous submitted prompt has scrolled out of
the viewport. Active signals include `Working`, `Thinking`, `Running`,
`Booting MCP server`, spinner lines, and approval questions, including bullet
or dash-prefixed variants. Do not enumerate Codex prompt placeholder text; prompt
suggestions are arbitrary and should not make a turn busy by themselves.

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
- A native-page submit can open another choice page instead of completing the
  action. Full Access currently opens a separate risk confirmation, and future
  Codex versions may add similar steps elsewhere. Parse numbered choice pages
  generically, keep the root action pending, patch the same Feishu card with
  the new options, and only report completion after the last interactive page
  has disappeared and a new idle prompt is visible. Release the previous card
  stage's submit lock when the replacement actions are ready.
- Commands such as `/review` cross from a native picker into an agent task.
  Start a next-turn rollout observer before submitting the picker selection;
  once history binds the generated task, stop terminal-page output and update
  the same card from rollout events only. Slash tasks such as `/compact`,
  `/init`, `/side`, and `/plan <prompt>` also bind the next observed rollout
  prompt instead of assuming the literal slash text is stored in history.
- Remote `/stop` and `/approve` intentionally retain Remote Codex control
  semantics. Use `/codex-stop` and `/codex-approve` for the native commands.
  Never expose `/archive`, `/delete`, `/logout`, `/exit`, or `/quit` remotely.

## Feishu Guidelines

- Normal Feishu remote turns default to one CardKit entity per turn. Keep
  `plugins.feishu.singleCardOutput` enabled, accumulate ordered commentary in
  that card's markdown element, then replace the body with `final_answer` and
  close the same card. Do not send one card per commentary event.
- The active card uses the blue processing state, a successful final uses the
  green completed state, and rollout binding/process failures use the red
  failure state. A full-card close that succeeds is authoritative even when a
  preceding element-content update failed; never send a second fallback card.
- Legacy segmented output is available only when `singleCardOutput` is false.
  It must still map one-to-one to ordered rollout events and never reconstruct
  sections from terminal text.
- `event_msg.task_complete` closes the turn. A visible idle prompt must not
  finalize or synthesize normal reply text.
- Static fallbacks should patch the original action card when the action came
  from a card.
- Treat the final CardKit payload as the remote-output acceptance boundary.
  Parser helpers may pass locally while Feishu still receives garbage; tests for
  Feishu regressions must inspect the exact markdown/text passed to
  `updateStreamingContent`, `closeStreamingCard`, or message send fallbacks.
- Normal remote turns may deliver commentary while Codex is working, but the
  final update must contain the `final_answer` text only. Do not merge prior
  commentary, `response_item` duplicates, tool events, terminal redraws, or
  local status pages back into it.
- File delivery directives are accepted only from structured final answers as
  exact standalone `[[remote-codex-file:/absolute/path]]` lines. Strip them from
  visible card text, validate real paths against the active Codex working
  directory, cap count and size, and deliver each valid file at most once.
  Upload failures must update the original task card to an orange partial
  completion state; never interpret terminal text as a file directive.
- Preserve meaningful line breaks in final answers. File lists, counts, bullet
  lists, code blocks, and multi-section answers should arrive in Feishu with
  the same semantic line structure after CardKit markdown formatting.
- Approval cards should list concrete approval options when Codex exposes them
  and should lock submit actions immediately to prevent repeated allow/deny
  clicks.
- Keep Feishu light-mode and dark-mode colors readable. Use the shared custom
  color tokens in `src/plugins/feishu/cardMarkdown.js` instead of ad hoc colors.
- Acknowledgement reactions are supported for accepted inbound messages through
  the Feishu message reaction API. Defaults live under
  `plugins.feishu.ackReactionEnabled` and `plugins.feishu.ackReactionEmoji`.
  Reaction failures should be logged and must not block command dispatch.
  Custom webhook mode cannot add reactions.
- Feishu message IDs come from receive-message events and card action contexts.
  Preserve them when patching cards, locking actions, and adding reactions.

## Debugging And Capture

- Normal operation must not record PTY input, output, or snapshots. Codex
  rollout JSONL is the fact source for normal progress and final answers. For a
  native page, approval, resize, or TUI rendering bug only, restart with
  `REMOTE_CODEX_DIAGNOSTIC_CAPTURE=1`; this developer mode records full terminal
  controls and parser decisions.
- Prefer visual or styled terminal snapshots for page parsing. Raw PTY bytes
  are useful for debugging and replay, but they can contain control sequences,
  redraw fragments, and stale screen content.
- Normal Feishu output must be invariant under terminal resize because resize
  events never enter the rollout output path.
- Terminal repaint artifacts are native-UI facts, not user-facing content.
  Fragments such as repeated `Working`, partial `codex_app...`, spinner
  leftovers, or bullet-prefixed redraw shards must never reach normal Feishu
  rendering, regardless of cleanup rules.
- Keep semantic signatures separate from display text. Formatting changes,
  progress bars, and color markers should not accidentally bypass duplicate
  suppression.
- Styled terminal color metadata is used only for native pages and local
  inspection. Normal rollout messages use Feishu's progress/final card colors.
- Use capture replay as a test harness when parser or state detection behavior
  is unclear. `capture:replay` rebuilds xterm state from the JSONL event stream
  and can emit deterministic frame fixtures for algorithm tests.
- `--frames /path/to/frames.jsonl` writes replay frames containing the event
  sequence, terminal size, counters, latest input context, viewport, and
  scrollback. By default frames are captured at terminal snapshots; add
  `--frame-mode all` when a failure depends on an intermediate output, input,
  resize, or exit event.
- `--parser-report /path/to/report.json` exports the recorded rollout/native
  trace timeline and decisions. It does not rerun a terminal answer parser.
  Use `--frame-mode all` when a native page or approval bug depends on an
  intermediate terminal event.

Useful commands:

```bash
npm run capture:replay -- /path/to/raw-output.jsonl
npm run capture:replay -- /path/to/raw-output.jsonl --frames /tmp/frames.jsonl
npm run capture:replay -- /path/to/raw-output.jsonl --parser-report /tmp/parser-report.json
npm run capture:replay -- /path/to/raw-output.jsonl --frames /tmp/frames.jsonl --frame-mode all
npm run capture:export-fixture -- /path/to/raw-output.jsonl /tmp/capture.fixture.jsonl
```

Local raw capture can contain prompts, command output, file contents, and user
messages. Do not commit unredacted captures; export fixtures with the redaction
tool first.

For tests that must reproduce exact terminal behavior, launch with
`REMOTE_CODEX_DIAGNOSTIC_CAPTURE=1`. Use
`REMOTE_CODEX_DIAGNOSTIC_CAPTURE_PATH=/path/to/capture.jsonl` when the default
location is unsuitable.

## Configuration Notes

- Defaults live in `src/config.js`; examples live in `config.example.json`.
- `updates.automaticEnabled` controls startup checks, background downloads, and
  install-on-exit. Manual checks remain available when it is disabled.
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

For Feishu output regressions, add the exact redacted rollout event sequence to
`scripts/test-codex-rollout-reader.js` or `scripts/test-feishu-remote-turn.js`.
The test should simulate receive-message -> PTY submit -> history binding ->
rollout events -> CardKit/message delivery and assert every payload exactly,
including order and line breaks. Terminal garbage should be injected in the
same test and asserted absent from all Feishu payloads.

Core checks:

```bash
npm run test:feishu-remote-turn
npm run test:codex-rollout-reader
npm run test:native-slash-pages
npm run test:native-slash-commands
npm run test:visual-session-state
npm run test:remote-workflow-state
npm run test:permission-card-actions
npm run test:terminal-capture
npm run test:remote-output-cleanup
npm run test:remote-control-input
npm run test:remote-file-delivery
npm run test:skill-install
npm run test:latex-renderer
npm run test:feishu-latex
npm run test:settings-ui
npm run test:app-updates
npm run smoke:feishu-rich-text
git diff --check
```

## Release CI Guardrails

- Release changes must be reviewed against both real matrix architectures,
  `x64` and `arm64`. Never hard-code x64 release IDs, archive names, checksum
  names, download URLs, or fixture paths in matrix-executed tests.
- Keep the naming boundary explicit: portable archives use `x64`/`arm64`, while
  Debian packages use `amd64`/`arm64`. Assert the generated updater metadata for
  the current matrix architecture.
- Do not use developer conveniences such as `rg` inside runtime, installer,
  release, or artifact-smoke shell scripts unless the workflow explicitly
  installs and verifies them. The instruction to prefer `rg` applies to agent
  repository searches, not to shipped automation.
- Retry only proven infrastructure failures. Docker exit 125 may be retried once
  because the container did not start; do not retry or hide build, test, audit,
  packaging, or smoke-test failures.
- Do not move a failed release tag. Increment the patch version in both package
  manifests, create a new tag, wait for both build jobs plus the publish job,
  and verify every expected Release asset. See `CONTRIBUTING.md` for the incident
  table and complete release checklist.

Also run targeted syntax checks for touched files, for example:

```bash
node -c src/main.js
node -c src/renderer.js
node -c src/remoteSessionController.js
node -c src/codexRolloutReader.js
node -c src/remoteControlInput.js
node -c src/remoteOutputCleanup.js
node -c src/remoteFileDelivery.js
node -c src/latexRenderer.js
node -c src/visualSessionState.js
node -c src/plugins/feishu/index.js
node -c src/plugins/feishu/cardActions.js
node -c src/plugins/feishu/cardBuilders.js
node -c src/plugins/feishu/cardMarkdown.js
node -c src/plugins/feishu/messageContent.js
node -c src/plugins/feishu/replyStream.js
```

Use `npm run smoke:native-slash -- --list` to capture the installed Codex slash
menu, or pass a command such as `/status`, `/resume`, `/permission`, `/model`,
`/skills`, `/mcp`, `/diff`, or `/review` for a real TUI smoke test. Codex may
need startup time before native slash commands respond, so tests and manual
checks must allow for loading and plugin-startup states.

## Reusable Helpers

- Use `CodexRolloutReader.beginTurn()` before writing the prompt to the PTY.
  Keep exact prompt, cwd, timestamp, session ID, and task boundary checks; do
  not replace them with "latest file" or "latest assistant message" guesses.
- Use `formatNativeSlashOutput` for native slash-page extraction.
- Use `isCompleteStatusSlashOutput` before finalizing `/status` streams or
  sending static `/status` fallbacks.
- Use `buildNativeSlashInput` and `writeNativeSlashCommand` to send native slash
  commands into the TUI.
- Use `buildControlInput`, `buildNativeControlInput`, and related permission
  helpers for keyboard controls and direct permission-mode buttons.
- Use `src/visualSessionState.js` helpers for visual active/idle/settled checks
  for native pages, approvals, and busy UX only. Never use them to decide
  normal answer content.
- Use `remoteMessageSignature`-style semantic comparison when suppressing
  duplicate output.
- Use the CardKit reply stream for normal Feishu turns and native pages that
  intentionally update in place. Treat one created card entity per normal turn
  as an acceptance invariant. Keep segmented-reply helpers only for explicit
  legacy configuration.
- Render final-answer LaTeX before closing the Feishu card. Block formulas are
  standalone images; short lines containing inline formulas are composed from
  local text-font and MathJax image segments on one fixed-width canvas. If text
  font loading, rendering, or upload fails, send a readable code-block fallback
  instead of a partial image.
- Treat explicit `\\(...\\)`, `\\[...\\]`, and `$$...$$` delimiters as
  authoritative even when the body is a single symbol such as `m` or `SE(3)`.
  Heuristics are only appropriate for ambiguous dollar or bare-bracket input.
  Use MathJax's promise API because matrices, `\\mathcal`, and other constructs
  can require asynchronous font or extension loading.
- Keep a captured long-form formula answer in the test fixtures. LaTeX
  regressions must assert both that every formula region renders and that the
  exact completed CardKit JSON contains image elements with no raw delimiters
  left behind. A small standalone formula test is not sufficient.
- Keep the default and normalization ceiling for `latexMaxFormulas` aligned.
  Tests must pass the configured value through `normalizeConfig()` and cover a
  response with more than the former 20-region limit. Log the effective limit,
  capped count, and failed count at the final-card boundary.

## Logging Guidance

- Runtime logs should explain why a card was sent, patched, ignored,
  deduplicated, or why a message reaction failed.
- Raw capture is an explicit, short-lived developer diagnostic and includes
  terminal control events needed for replay. It must never be enabled by a
  persisted user setting.
- Parser/debug logs may include clipped rollout text and terminal snapshots,
  but avoid logging secrets. Existing logger redaction should be preserved.
- Add structured event fields for phase, command, action, message ID, session
  ID, and dedupe reason when diagnosing workflow bugs.

## Editing Rules For Agents

- Prefer small, scoped changes that follow existing modules.
- Do not revert unrelated dirty worktree changes.
- Use `rg` for repository searches.
- Use `apply_patch` for manual edits.
- Keep tests close to the behavior being changed. Rollout changes need
  deterministic JSONL event streams; native page changes need snapshots; card
  behavior needs exact payload assertions;
  workflow changes need state-machine tests; renderer controls need at least
  syntax checks and, where practical, state/controller tests behind their IPC.
