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
npm run smoke:linux-artifact -- x64
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

## Release installation policy

Ubuntu and Debian users are the primary packaged-install audience. User-facing
documentation and release notes should lead with the `.deb` packages, using
these stable architecture names:

| Host architecture | Debian asset | Portable asset |
| --- | --- | --- |
| `x86_64` | `remote-codex-linux-amd64.deb` | `remote-codex-linux-x64.tar.gz` |
| `arm64` | `remote-codex-linux-arm64.deb` | `remote-codex-linux-arm64.tar.gz` |

Keep the portable archive and `install.sh` as supported alternatives for
non-Debian systems and installations without `sudo`. Do not make a
`curl ... | bash` pipeline the primary or only documented installation path.
When documenting the script, download the release-published `install.sh` to a
file before running it so an interrupted script transfer cannot feed partial
content directly to Bash.

Every release-facing change must preserve these acceptance points:

- The latest-release URLs in `README.md` resolve to both `.deb` files and their
  matching `.sha256` files.
- `sha256sum --check` succeeds before installation instructions invoke APT.
- `sudo apt install ./remote-codex-linux-<deb-arch>.deb` installs dependencies,
  the desktop entry, and the `remote-codex` command.
- The user-local installer verifies the complete portable archive before its
  atomic `current` symlink switch; a failed download must leave the active
  release unchanged.
- Renaming an asset requires coordinated updates to `electron-builder.yml`,
  updater metadata, release CI, checksum generation, smoke tests, and
  user-facing documentation.

## Release CI checklist

Release CI builds on two real runner architectures. A green x64 build does not
predict a green arm64 build, so every release-related change must satisfy all
of these rules:

- Keep test fixtures architecture-aware. Portable archives use `x64` or
  `arm64`; Debian packages use `amd64` or `arm64`. Do not hard-code an x64
  asset, install-directory suffix, checksum filename, or expected URL in a test
  that runs in the architecture matrix.
- Treat a GitHub runner as a minimal environment. Release and smoke scripts may
  use standard Ubuntu/POSIX tools, but must not assume developer utilities such
  as `rg` are installed. If a non-baseline command is necessary, install it in
  the workflow explicitly and check it with `command -v` before use.
- Keep infrastructure retries narrow. The container build may retry Docker exit
  code 125 once because that means the container did not start. Never retry or
  mask a nonzero exit from the build, tests, audit, or artifact smoke test.
- Run deterministic checks and the production dependency audit on both matrix
  runners before packaging. Smoke-test the actual archive and `.deb`, not a
  reconstructed fixture, before uploading assets.
- Keep release tags immutable. The tag must exactly match the versions in
  `package.json` and `package-lock.json`. If a tagged run fails, fix the cause,
  increment the patch version, and create a new tag; never move or overwrite
  the failed tag.
- Consider a release complete only after both architecture jobs and the publish
  job succeed, and the Release contains both archives, both `.deb` files, their
  checksums, both `latest-linux*.yml` files, `remote-codex-version.txt`, and
  `install.sh`. Open the published Release as an unauthenticated user and check
  the README's latest-release package links before announcing it.

### Previous failures and the rule they established

| Failure | Root cause | Permanent prevention |
| --- | --- | --- |
| Container build did not start | A transient Docker startup failure returned exit 125. | Retry only exit 125 once; preserve every real build failure. |
| arm64 deterministic tests failed | The updater fixture embedded x64 release IDs and asset names. | Derive matrix-sensitive fixture names from the current architecture and assert both naming schemes. |
| arm64 artifact smoke failed with exit 127 | The script used `rg`, which was installed locally but absent from the ARM runner. | Use baseline tools in release scripts or install and verify every extra tool in the workflow. |

When a release fails, record the failing job, step, exit code, and exact missing
assumption before changing code. A local x64 pass alone is not sufficient
evidence for a release fix.

## Pull requests

Keep changes scoped and explain the user-visible behavior, tests performed, and
any compatibility impact. Never commit unredacted terminal captures; use the
fixture export tool described in `README.md`.
