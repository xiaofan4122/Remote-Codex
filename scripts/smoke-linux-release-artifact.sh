#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_CODEX_SMOKE_ARCH="${1:-}"
case "${REMOTE_CODEX_SMOKE_ARCH}" in
  x64)
    REMOTE_CODEX_SMOKE_DEB_ARCH=amd64
    REMOTE_CODEX_SMOKE_UPDATE_METADATA=latest-linux.yml
    ;;
  arm64)
    REMOTE_CODEX_SMOKE_DEB_ARCH=arm64
    REMOTE_CODEX_SMOKE_UPDATE_METADATA=latest-linux-arm64.yml
    ;;
  *)
    printf 'Usage: %s <x64|arm64> [version]\n' "$0" >&2
    exit 1
    ;;
esac

REMOTE_CODEX_SMOKE_VERSION="${2:-$(node -p 'require("./package.json").version')}"
REMOTE_CODEX_SMOKE_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_CODEX_SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/remote-codex-release-smoke.XXXXXX")"

cleanup() {
  case "${REMOTE_CODEX_SMOKE_ROOT}" in
    "${TMPDIR:-/tmp}"/remote-codex-release-smoke.*)
      rm -rf -- "${REMOTE_CODEX_SMOKE_ROOT}"
      ;;
  esac
}
trap cleanup EXIT

REMOTE_CODEX_SMOKE_HOME="${REMOTE_CODEX_SMOKE_ROOT}/home"
REMOTE_CODEX_SMOKE_INSTALL_ROOT="${REMOTE_CODEX_SMOKE_HOME}/.local/opt/remote-codex"
REMOTE_CODEX_SMOKE_BIN_DIR="${REMOTE_CODEX_SMOKE_HOME}/.local/bin"
REMOTE_CODEX_SMOKE_CODEX_HOME="${REMOTE_CODEX_SMOKE_HOME}/.codex"
mkdir -p "${REMOTE_CODEX_SMOKE_HOME}"

env \
  HOME="${REMOTE_CODEX_SMOKE_HOME}" \
  REMOTE_CODEX_DOWNLOAD_BASE="file://${REMOTE_CODEX_SMOKE_PROJECT_ROOT}/dist" \
  REMOTE_CODEX_INSTALL_ROOT="${REMOTE_CODEX_SMOKE_INSTALL_ROOT}" \
  REMOTE_CODEX_BIN_DIR="${REMOTE_CODEX_SMOKE_BIN_DIR}" \
  REMOTE_CODEX_CODEX_HOME_DIR="${REMOTE_CODEX_SMOKE_CODEX_HOME}" \
  REMOTE_CODEX_ARCH="${REMOTE_CODEX_SMOKE_ARCH}" \
  REMOTE_CODEX_SKIP_DESKTOP=1 \
  bash "${REMOTE_CODEX_SMOKE_PROJECT_ROOT}/install.sh" \
    --version "${REMOTE_CODEX_SMOKE_VERSION}" \
    --no-desktop

REMOTE_CODEX_SMOKE_CURRENT="${REMOTE_CODEX_SMOKE_INSTALL_ROOT}/current"
test -L "${REMOTE_CODEX_SMOKE_CURRENT}"
test -x "${REMOTE_CODEX_SMOKE_BIN_DIR}/remote-codex"
test -x "${REMOTE_CODEX_SMOKE_BIN_DIR}/remote-codex-uninstall"
test -f "${REMOTE_CODEX_SMOKE_CURRENT}/resources/app.asar"
test -f "${REMOTE_CODEX_SMOKE_CURRENT}/resources/skills/remote-codex-send-files/SKILL.md"
test -f "${REMOTE_CODEX_SMOKE_CODEX_HOME}/skills/remote-codex-send-files/SKILL.md"

REMOTE_CODEX_SMOKE_PTY_MODULE="$(
  find "${REMOTE_CODEX_SMOKE_CURRENT}/resources" \
    -type f -path '*/node-pty/build/Release/pty.node' -print -quit
)"
test -n "${REMOTE_CODEX_SMOKE_PTY_MODULE}"
REMOTE_CODEX_SMOKE_LDD_OUTPUT="$(ldd "${REMOTE_CODEX_SMOKE_PTY_MODULE}")" || {
  printf 'Packaged node-pty is not a valid dynamic Linux module.\n' >&2
  exit 1
}
if printf '%s\n' "${REMOTE_CODEX_SMOKE_LDD_OUTPUT}" | grep -q 'not found'; then
  printf 'Packaged node-pty has unresolved shared libraries.\n' >&2
  exit 1
fi

REMOTE_CODEX_SMOKE_DEB="${REMOTE_CODEX_SMOKE_PROJECT_ROOT}/dist/remote-codex-linux-${REMOTE_CODEX_SMOKE_DEB_ARCH}.deb"
REMOTE_CODEX_SMOKE_METADATA="${REMOTE_CODEX_SMOKE_PROJECT_ROOT}/dist/${REMOTE_CODEX_SMOKE_UPDATE_METADATA}"
REMOTE_CODEX_SMOKE_DEB_ROOT="${REMOTE_CODEX_SMOKE_ROOT}/deb-root"
test -f "${REMOTE_CODEX_SMOKE_DEB}"
test -f "${REMOTE_CODEX_SMOKE_METADATA}"
dpkg-deb --info "${REMOTE_CODEX_SMOKE_DEB}" >/dev/null
dpkg-deb -x "${REMOTE_CODEX_SMOKE_DEB}" "${REMOTE_CODEX_SMOKE_DEB_ROOT}"
REMOTE_CODEX_SMOKE_DEB_RESOURCES="${REMOTE_CODEX_SMOKE_DEB_ROOT}/opt/Remote Codex/resources"
test "$(tr -d '[:space:]' < "${REMOTE_CODEX_SMOKE_DEB_RESOURCES}/package-type")" = deb
test -x "${REMOTE_CODEX_SMOKE_DEB_RESOURCES}/install/install-linux.sh"
grep -q '^provider: github$' "${REMOTE_CODEX_SMOKE_DEB_RESOURCES}/app-update.yml"
grep -q "^version: ${REMOTE_CODEX_SMOKE_VERSION}$" "${REMOTE_CODEX_SMOKE_METADATA}"
grep -q "remote-codex-linux-${REMOTE_CODEX_SMOKE_DEB_ARCH}\\.deb" "${REMOTE_CODEX_SMOKE_METADATA}"

env \
  HOME="${REMOTE_CODEX_SMOKE_HOME}" \
  REMOTE_CODEX_INSTALL_ROOT="${REMOTE_CODEX_SMOKE_INSTALL_ROOT}" \
  REMOTE_CODEX_BIN_DIR="${REMOTE_CODEX_SMOKE_BIN_DIR}" \
  REMOTE_CODEX_CODEX_HOME_DIR="${REMOTE_CODEX_SMOKE_CODEX_HOME}" \
  REMOTE_CODEX_SKIP_DESKTOP=1 \
  "${REMOTE_CODEX_SMOKE_BIN_DIR}/remote-codex-uninstall" --yes

test ! -e "${REMOTE_CODEX_SMOKE_INSTALL_ROOT}"
test ! -e "${REMOTE_CODEX_SMOKE_BIN_DIR}/remote-codex"
printf 'Remote Codex Linux %s release artifact smoke test passed.\n' \
  "${REMOTE_CODEX_SMOKE_ARCH}"
