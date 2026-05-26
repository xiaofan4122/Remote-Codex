#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${HOME}/.local/share/applications"
APP_COMMAND="${BIN_DIR}/remote-codex"
API_COMMAND="${BIN_DIR}/remote-codex-api"
DESKTOP_FILE="${DESKTOP_DIR}/remote-codex.desktop"
LEGACY_APP_COMMAND="${BIN_DIR}/codex-shell"
LEGACY_API_COMMAND="${BIN_DIR}/codex-shell-api"
LEGACY_DESKTOP_FILE="${DESKTOP_DIR}/codex-shell.desktop"

mkdir -p "${BIN_DIR}" "${DESKTOP_DIR}"

cat > "${APP_COMMAND}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR}"
LAUNCH_CWD="\${PWD}"

if ! command -v npm >/dev/null 2>&1 && [ -s "\${HOME}/.nvm/nvm.sh" ]; then
  . "\${HOME}/.nvm/nvm.sh"
fi

export REMOTE_CODEX_LAUNCH_CWD="\${REMOTE_CODEX_LAUNCH_CWD:-\${LAUNCH_CWD}}"
cd "\${APP_DIR}"
exec npm start
EOF

cat > "${API_COMMAND}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR}"
LAUNCH_CWD="\${PWD}"

if ! command -v npm >/dev/null 2>&1 && [ -s "\${HOME}/.nvm/nvm.sh" ]; then
  . "\${HOME}/.nvm/nvm.sh"
fi

export REMOTE_CODEX_LAUNCH_CWD="\${REMOTE_CODEX_LAUNCH_CWD:-\${LAUNCH_CWD}}"
cd "\${APP_DIR}"
exec npm run api
EOF

chmod +x "${APP_COMMAND}" "${API_COMMAND}"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=Remote Codex
Comment=Run Codex CLI in a desktop window
Exec=${APP_COMMAND}
Icon=utilities-terminal
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
echo "  ${API_COMMAND}"
echo "  ${DESKTOP_FILE}"
echo
echo "Open the app with:"
echo "  remote-codex"
echo
echo "Start the headless API with:"
echo "  remote-codex-api"
