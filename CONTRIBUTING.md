# Contributing to Remote Codex

Remote Codex is intentionally a Linux-only Electron shell around the native
Codex CLI. Contributions should preserve the visible PTY workflow while using
Codex rollout JSONL as the only source for normal progress and final answers.

## Development setup

Install Node.js 22.12 or newer and the Codex CLI, then run:

```bash
npm ci
npm start
```

Before opening a pull request:

```bash
npm run check
npm run dist:linux:x64
git diff --check
```

The release build includes the Electron runtime and native `node-pty` module.
Do not add a runtime requirement for users to install Node.js or compile native
dependencies.

## Scope

- Build release binaries with `scripts/build-linux-release-container.sh` so
  native modules retain the declared glibc 2.31 compatibility baseline.
- Keep `x64` and `arm64` release behavior equivalent.
- Do not add macOS- or Windows-specific code, packaging, documentation, or CI.
- Keep Feishu credentials and diagnostic captures out of commits and issue
  attachments.
- Add focused deterministic tests for parser, CardKit, installer, configuration,
  native-page, and workflow changes.

Read `AGENTS.md` and `ARCHITECTURE.md` before changing the rollout, PTY, remote
controller, or Feishu boundaries.

## Pull requests

Keep changes scoped and explain the user-visible behavior, tests performed, and
any compatibility impact. Never commit unredacted terminal captures; use the
fixture export tool described in `README.md`.
