---
name: remote-codex-send-files
description: Send files created in the current Codex workspace back through Remote Codex to the active Feishu chat. Use when a remote user asks to send, attach, deliver, or download a generated report, archive, image, document, data file, patch, or other workspace artifact.
---

# Remote Codex Send Files

Use Remote Codex's final-answer file directive after the requested artifact is fully written.

## Send A File

1. Create or finish the requested file inside the current working directory.
2. Verify that it is a regular, non-empty file and no larger than 30 MB.
3. In the final answer, briefly describe the result and add this exact standalone line:

```text
[[remote-codex-file:/absolute/path/to/the/file]]
```

Use an absolute path. Do not wrap the actual directive in a code block, quote, bullet, or prose. Add one standalone directive per file, with at most five files in one turn.

Remote Codex removes directive lines from the visible completion card, validates the files, uploads them, and sends Feishu file messages.

## Boundaries

- Keep every file inside the current working directory after symlink resolution. A symlink must not escape the workspace.
- Archive a directory into a file inside the workspace before declaring it.
- Emit directives only in the final answer, never in progress commentary.
- Do not emit a directive before the file is completely written.
- Do not call Feishu APIs, use webhook credentials, or upload the file yourself.
- Do not claim that delivery succeeded. Remote Codex reports validation or upload failures on the task card.
