#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${HOME}/.local/share/applications"
CODEX_HOME_DIR="${CODEX_HOME:-${HOME}/.codex}"
SKILL_SOURCE_DIR="${APP_DIR}/skills/remote-codex-send-files"
SKILL_DIR="${CODEX_HOME_DIR}/skills/remote-codex-send-files"
APP_COMMAND="${BIN_DIR}/remote-codex"
DEV_COMMAND="${BIN_DIR}/remote-codex-dev"
API_COMMAND="${BIN_DIR}/remote-codex-api"
DESKTOP_FILE="${DESKTOP_DIR}/remote-codex.desktop"
ICON_FILE="${APP_DIR}/build/icons/512x512.png"
LEGACY_APP_COMMAND="${BIN_DIR}/codex-shell"
LEGACY_API_COMMAND="${BIN_DIR}/codex-shell-api"
LEGACY_DESKTOP_FILE="${DESKTOP_DIR}/codex-shell.desktop"

mkdir -p "${BIN_DIR}" "${DESKTOP_DIR}"

if [ ! -f "${ICON_FILE}" ]; then
  echo "Remote Codex icon is missing: ${ICON_FILE}" >&2
  exit 1
fi

install_remote_codex_skill() {
  if [ ! -f "${SKILL_SOURCE_DIR}/SKILL.md" ] || [ ! -f "${SKILL_SOURCE_DIR}/agents/openai.yaml" ]; then
    echo "Remote Codex file-send skill source is incomplete: ${SKILL_SOURCE_DIR}" >&2
    exit 1
  fi
  if [ -L "${SKILL_DIR}" ] || [ -L "${SKILL_DIR}/agents" ]; then
    echo "Refusing to overwrite symlinked skill path: ${SKILL_DIR}" >&2
    exit 1
  fi

  mkdir -p "${SKILL_DIR}/agents"
  cp "${SKILL_SOURCE_DIR}/SKILL.md" "${SKILL_DIR}/SKILL.md"
  cp "${SKILL_SOURCE_DIR}/agents/openai.yaml" "${SKILL_DIR}/agents/openai.yaml"
}

install_remote_codex_skill

cat > "${APP_COMMAND}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR}"
LAUNCH_CWD="\${PWD}"

USER_SHELL="\${SHELL:-}"
if [ -z "\${REMOTE_CODEX_SHELL_ENV_READY:-}" ] && [ "\${REMOTE_CODEX_SKIP_SHELL_ENV:-}" != "1" ] && [ -n "\${USER_SHELL}" ] && [ -x "\${USER_SHELL}" ]; then
  export REMOTE_CODEX_SHELL_ENV_READY=1
  SELF=\$(printf '%q' "\$0")
  ARGS=""
  for ARG in "\$@"; do
    ARGS="\${ARGS} \$(printf '%q' "\${ARG}")"
  done
  exec "\${USER_SHELL}" -lic "exec \${SELF}\${ARGS}"
fi

if ! command -v npm >/dev/null 2>&1 && [ -s "\${HOME}/.nvm/nvm.sh" ]; then
  . "\${HOME}/.nvm/nvm.sh"
fi

export REMOTE_CODEX_LAUNCH_CWD="\${REMOTE_CODEX_LAUNCH_CWD:-\${LAUNCH_CWD}}"
cd "\${APP_DIR}"
exec npm start -- "\$@"
EOF

cat > "${DEV_COMMAND}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR}"

USER_SHELL="\${SHELL:-}"
if [ -z "\${REMOTE_CODEX_SHELL_ENV_READY:-}" ] && [ "\${REMOTE_CODEX_SKIP_SHELL_ENV:-}" != "1" ] && [ -n "\${USER_SHELL}" ] && [ -x "\${USER_SHELL}" ]; then
  export REMOTE_CODEX_SHELL_ENV_READY=1
  SELF=\$(printf '%q' "\$0")
  ARGS=""
  for ARG in "\$@"; do
    ARGS="\${ARGS} \$(printf '%q' "\${ARG}")"
  done
  exec "\${USER_SHELL}" -lic "exec \${SELF}\${ARGS}"
fi

if ! command -v npm >/dev/null 2>&1 && [ -s "\${HOME}/.nvm/nvm.sh" ]; then
  . "\${HOME}/.nvm/nvm.sh"
fi

export REMOTE_CODEX_USE_CONFIG_DEFAULT_CWD=1
unset REMOTE_CODEX_LAUNCH_CWD
cd "\${APP_DIR}"
exec npm start -- "\$@"
EOF

cat > "${API_COMMAND}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR}"
LAUNCH_CWD="\${PWD}"

USER_SHELL="\${SHELL:-}"
if [ -z "\${REMOTE_CODEX_SHELL_ENV_READY:-}" ] && [ "\${REMOTE_CODEX_SKIP_SHELL_ENV:-}" != "1" ] && [ -n "\${USER_SHELL}" ] && [ -x "\${USER_SHELL}" ]; then
  export REMOTE_CODEX_SHELL_ENV_READY=1
  SELF=\$(printf '%q' "\$0")
  ARGS=""
  for ARG in "\$@"; do
    ARGS="\${ARGS} \$(printf '%q' "\${ARG}")"
  done
  exec "\${USER_SHELL}" -lic "exec \${SELF}\${ARGS}"
fi

if ! command -v npm >/dev/null 2>&1 && [ -s "\${HOME}/.nvm/nvm.sh" ]; then
  . "\${HOME}/.nvm/nvm.sh"
fi

export REMOTE_CODEX_LAUNCH_CWD="\${REMOTE_CODEX_LAUNCH_CWD:-\${LAUNCH_CWD}}"
cd "\${APP_DIR}"
exec npm run api -- "\$@"
EOF

chmod +x "${APP_COMMAND}" "${API_COMMAND}"
chmod +x "${DEV_COMMAND}"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=Remote Codex
Comment=Run Codex CLI in a desktop window
Exec=${APP_COMMAND}
Icon=${ICON_FILE}
Terminal=false
Categories=Development;
StartupNotify=true
EOF

chmod +x "${DESKTOP_FILE}"

ensure_shell_path() {
  local rc_file="$1"
  local marker_start="# >>> remote-codex >>>"
  local marker_end="# <<< remote-codex <<<"
  local legacy_marker_start="# >>> codex-electron-shell >>>"
  local legacy_marker_end="# <<< codex-electron-shell <<<"

  touch "${rc_file}"

  if grep -Fq "${legacy_marker_start}" "${rc_file}"; then
    awk -v start="${legacy_marker_start}" -v end="${legacy_marker_end}" '
      $0 == start { skip = 1; next }
      $0 == end { skip = 0; next }
      !skip { print }
    ' "${rc_file}" > "${rc_file}.remote-codex.tmp"
    mv "${rc_file}.remote-codex.tmp" "${rc_file}"
  fi

  if grep -Fq "${marker_start}" "${rc_file}"; then
    return
  fi

  cat >> "${rc_file}" <<'EOF'

# >>> remote-codex >>>
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# <<< remote-codex <<<
EOF
}

ensure_shell_path "${HOME}/.zshrc"
ensure_shell_path "${HOME}/.bashrc"

cleanup_legacy_file() {
  local file="$1"
  local needle="$2"

  if [ -f "${file}" ] && grep -Fq "${needle}" "${file}"; then
    rm -f "${file}"
  fi
}

cleanup_legacy_file "${LEGACY_APP_COMMAND}" "${APP_DIR}"
cleanup_legacy_file "${LEGACY_API_COMMAND}" "${APP_DIR}"
cleanup_legacy_file "${LEGACY_DESKTOP_FILE}" "codex-shell"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${DESKTOP_DIR}" >/dev/null 2>&1 || true
fi

echo "Installed:"
echo "  ${APP_COMMAND}"
echo "  ${DEV_COMMAND}"
echo "  ${API_COMMAND}"
echo "  ${DESKTOP_FILE}"
echo "  ${ICON_FILE}"
echo "  ${SKILL_DIR}"
echo
echo "Open the app with:"
echo "  remote-codex"
echo "  remote-codex-dev"
echo
echo "Start the headless API with:"
echo "  remote-codex-api"
