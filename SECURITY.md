# Security Policy

## Supported versions

Security fixes are applied to the latest published Remote Codex release. The
project supports Linux `x64` and `arm64` only.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** security-advisory flow
for this repository. Do not open a public issue for an unpatched vulnerability
and do not attach credentials, Codex rollout files, or raw terminal captures.

Include the affected version, Linux distribution and architecture, impact,
reproduction steps, and any proposed mitigation. Maintainers should acknowledge
a complete report within seven days and coordinate disclosure after a fix is
available.

## Sensitive local data

Remote Codex can access local projects, Codex session files, and Feishu app
credentials. Configuration files are written with user-only permissions.
Native-TUI diagnostic capture is disabled by default and must remain an
explicit, short-lived developer action.
