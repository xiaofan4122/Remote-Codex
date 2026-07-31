#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_CODEX_REPOSITORY="${REMOTE_CODEX_REPOSITORY:-xiaofan4122/Remote-Codex}"
REMOTE_CODEX_INSTALL_ROOT="${REMOTE_CODEX_INSTALL_ROOT:-${HOME}/.local/opt/remote-codex}"
REMOTE_CODEX_BIN_DIR="${REMOTE_CODEX_BIN_DIR:-${HOME}/.local/bin}"
REMOTE_CODEX_DESKTOP_DIR="${REMOTE_CODEX_DESKTOP_DIR:-${HOME}/.local/share/applications}"
REMOTE_CODEX_SKILL_HOME="${REMOTE_CODEX_CODEX_HOME_DIR:-${CODEX_HOME:-${HOME}/.codex}}"
REMOTE_CODEX_ASSUME_YES=0
REMOTE_CODEX_KEEP_SKILL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)
      REMOTE_CODEX_ASSUME_YES=1
      ;;
    --keep-skill)
      REMOTE_CODEX_KEEP_SKILL=1
      ;;
    -h|--help)
      printf 'Usage: remote-codex-uninstall [--yes] [--keep-skill]\n'
      exit 0
      ;;
    *)
      printf 'remote-codex uninstaller: unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

case "${REMOTE_CODEX_INSTALL_ROOT}" in
  /*/remote-codex) ;;
  *)
    printf 'remote-codex uninstaller: refusing unexpected install root: %s\n' \
      "${REMOTE_CODEX_INSTALL_ROOT}" >&2
    exit 1
    ;;
esac

if [ "${REMOTE_CODEX_ASSUME_YES}" != '1' ]; then
  if [ ! -t 0 ]; then
    printf 'Run remote-codex-uninstall --yes in non-interactive mode.\n' >&2
    exit 1
  fi
  printf 'Remove Remote Codex from %s? [y/N] ' "${REMOTE_CODEX_INSTALL_ROOT}"
  read -r REMOTE_CODEX_CONFIRMATION
  case "${REMOTE_CODEX_CONFIRMATION}" in
    y|Y|yes|YES) ;;
    *) printf 'Cancelled.\n'; exit 0 ;;
  esac
fi

remove_managed_link() {
  local remote_codex_link="$1"
  if [ ! -L "${remote_codex_link}" ]; then
    return
  fi
  local remote_codex_target
  remote_codex_target="$(readlink "${remote_codex_link}")"
  case "${remote_codex_target}" in
    "${REMOTE_CODEX_INSTALL_ROOT}"/*)
      rm -f -- "${remote_codex_link}"
      ;;
    *)
      printf 'Leaving unrelated symlink untouched: %s\n' "${remote_codex_link}" >&2
      ;;
  esac
}

remove_managed_link "${REMOTE_CODEX_BIN_DIR}/remote-codex"
remove_managed_link "${REMOTE_CODEX_BIN_DIR}/remote-codex-uninstall"

REMOTE_CODEX_DESKTOP_FILE="${REMOTE_CODEX_DESKTOP_DIR}/remote-codex.desktop"
if [ -f "${REMOTE_CODEX_DESKTOP_FILE}" ] &&
   grep -Fq 'X-Remote-Codex-Managed=true' "${REMOTE_CODEX_DESKTOP_FILE}"; then
  rm -f -- "${REMOTE_CODEX_DESKTOP_FILE}"
fi

if [ "${REMOTE_CODEX_KEEP_SKILL}" != '1' ]; then
  REMOTE_CODEX_SKILL_DIR="${REMOTE_CODEX_SKILL_HOME}/skills/remote-codex-send-files"
  REMOTE_CODEX_SKILL_MARKER="${REMOTE_CODEX_SKILL_DIR}/.remote-codex-managed"
  if [ -f "${REMOTE_CODEX_SKILL_MARKER}" ] &&
     grep -Fq "repository=${REMOTE_CODEX_REPOSITORY}" "${REMOTE_CODEX_SKILL_MARKER}" &&
     [ ! -L "${REMOTE_CODEX_SKILL_DIR}" ]; then
    rm -rf -- "${REMOTE_CODEX_SKILL_DIR}"
  fi
fi

if [ -d "${REMOTE_CODEX_INSTALL_ROOT}" ]; then
  rm -rf -- "${REMOTE_CODEX_INSTALL_ROOT}"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${REMOTE_CODEX_DESKTOP_DIR}" >/dev/null 2>&1 || true
fi

printf 'Remote Codex was removed. Configuration under ~/.remote-codex.json was preserved.\n'
