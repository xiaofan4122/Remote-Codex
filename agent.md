# Agent Notes

This file records project-specific gotchas for future agents working on Remote Codex.

## Remote Input Modes

- `visual_terminal` is the mode that mirrors the visible Codex TUI. Keep this mode when the user wants Feishu messages to drive slash commands such as `/resume`, `/plan`, `/model`, or approval prompts.
- `app_server` and `exec_json` are structured-event modes. They are better for stable final answers, but they do not operate the visible TUI slash-command workflow.
- Code changes to remote input usually require restarting the running Electron/API process before Feishu behavior changes.

## Slash Commands

Remote Codex intercepts these commands before they reach Codex:

```text
/help
/start [cwd]
/stop
/status
/tail
/approve
/always
/deny
/esc
/enter
/up
/down
/left
/right
/tab
```

Other slash commands should pass through to Codex in `visual_terminal` mode.
Examples: `/resume`, `/plan`, `/permissions`, `/model`.

If a user needs to send a command that conflicts with a Remote Codex command, add an explicit passthrough syntax before changing behavior globally. Good candidates are `/codex /status` or `//status`.

## `/resume` And Other TUI Commands

Known user-visible cases:

- Remote Codex can start directly in Codex resume mode. Use `remote-codex --resume --last`, `remote-codex --resume <session-id>`, or `remote-codex resume --last`.
- Environment fallback: `REMOTE_CODEX_RESUME=last remote-codex` resumes the most recent session. Use `REMOTE_CODEX_RESUME=<session-id>` for a specific session and `REMOTE_CODEX_RESUME_PROMPT=<text>` for an initial prompt.
- When launched with resume options, the visible session should spawn as `codex resume --no-alt-screen ...`.
- If `/resume` appears in the Codex input box and the cursor moves to a new line but nothing happens, the remote input was likely inserted without a real Enter key event, or Codex is treating it as pasted input.
- `buildSubmitInput('/resume')` should produce `"/resume\r"`, not bracketed paste and not Tab.
- Normal prompts should still use bracketed paste plus Enter: `"\x1b[200~...\x1b[201~\r"`.
- Single-line passthrough slash commands should be typed as keyboard input plus `\r`.
- Multi-line content should not use the slash-command fast path.
- If `/resume` opens a selection UI, no answer text is expected until the user chooses an item. Use `/up`, `/down`, and `/enter`.
- If Codex is already running a turn, a slash command may be queued or ignored by the TUI. Use `/esc` to interrupt, then send the command again.
- If the command is visible in the Electron terminal but Feishu receives no reply, inspect the visible TUI first; the TUI may be waiting for a menu selection, approval, login, or model/provider state.

Useful checks:

```bash
node -e "const {buildSubmitInput}=require('./src/remoteSessionController'); console.log(JSON.stringify(buildSubmitInput('/resume')))"
tail -n 120 ~/.local/state/remote-codex/remote-codex.log
```

Expected slash output:

```text
"/resume\r"
```

## Restart Environment

- Prefer launching Remote Codex through the installed `remote-codex` launcher, not `npm start` directly, so startup options and shell environment handling stay consistent.
- The launcher re-enters the user's default shell with `-lic` once before starting Electron. This matters on this machine because zsh startup files provide PATH and other environment that may affect Codex colors and terminal behavior.
- Avoid hard-coding `bash -lc` in restart commands. If a terminal wrapper is needed, use the installed launcher from the user's normal shell, for example `gnome-terminal -- zsh -lic 'cd /path/to/app && remote-codex --resume --last; exec zsh'`.
- Set `REMOTE_CODEX_SKIP_SHELL_ENV=1` only when intentionally debugging a minimal startup environment.

## Feishu Reply Behavior

- Feishu may fail to create a streaming card if permissions are missing. In that case Remote Codex falls back to normal card/text replies.
- In `visual_terminal` final-output mode, the terminal snapshot can expose a gradually growing final answer. Do not send every growing prefix as a separate Feishu message.
- Keep final-answer debounce behavior for non-streaming fallback. The current default is `remoteControl.finalReplyDebounceMs = 6000`.
- A new user message can arrive while the terminal still displays the previous final answer. Always associate visual snapshots with the latest submitted prompt before extracting a reply.
- Feishu duplicate delivery should be handled by message ID de-duplication in the Feishu plugin, but repeated `remote.reply.sent` logs usually mean Remote Codex emitted multiple replies internally.

## Remote Approval

- Codex approval prompts look like `Would you like to run the following command?` with hotkeys: `y` for one-time approval, `p` for persistent approval, and `esc` for deny/cancel.
- `/approve` should send `y`, not Enter. `/always` should send `p`. `/enter` is only for choosing the currently highlighted menu item.
- Before sending `y` or `p`, Remote Codex should detect an active approval prompt from the visual snapshot or recent raw PTY output. If no prompt is detected, reply with a permission status card instead of typing into the Codex composer.
- In non-streaming Feishu fallback mode, approval prompts still need an immediate `permission` panel with buttons; do not wait for a final answer.
- Permission panels should include buttons for approve, always approve, deny, up, down, and enter so the user can recover if Codex changes selection focus.

## Debugging Remote Runs

Prefer checking these logs/events first:

- `feishu.message.received`: Feishu delivered the message.
- `feishu.message.accepted`: allowlist and mention checks passed.
- `remote.message.received`: the remote controller started handling it.
- `remote.reply.sent`: Remote Codex decided to send a reply.
- `feishu.card.send` or `feishu.text.send`: the Feishu plugin sent output.
- `remote.reply.ignored`: output was captured but not considered a final answer.

When a user reports duplicate replies, compare `remote.reply.sent` with `feishu.card.send`. If both repeat with growing text, fix the controller output scheduling. If Feishu receive events repeat with the same message ID, fix plugin de-duplication.

## Mention Handling

If `plugins.feishu.requireMention` is enabled, a message without a bot mention is ignored. Mention text is stripped before forwarding to Codex. When testing command passthrough, verify the normalized message text in `feishu.message.accepted`.
