#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
# shellcheck source=development-version-toggle-common.sh
. "${SCRIPT_DIR}/development-version-toggle-common.sh"

SOURCE_DIR="$(remote_codex_resolve_source_dir)"
LAUNCHER_PATH="${HOME}/${REMOTE_CODEX_LAUNCHER_RELATIVE_PATH}"
DESKTOP_PATH="${HOME}/${REMOTE_CODEX_DESKTOP_RELATIVE_PATH}"
LAUNCHER_BACKUP="${LAUNCHER_PATH}${REMOTE_CODEX_BACKUP_SUFFIX}"
DESKTOP_BACKUP="${DESKTOP_PATH}${REMOTE_CODEX_BACKUP_SUFFIX}"

validate_restore_target() {
  local current="$1"
  local backup="$2"
  local kind="$3"

  if remote_codex_path_exists "${current}" && remote_codex_path_exists "${backup}"; then
    echo "错误：${kind}及其备份同时存在，拒绝覆盖：${current}" >&2
    return 1
  fi
  if remote_codex_path_exists "${current}"; then
    echo "${kind}已经恢复：${current}"
    return 0
  fi
  if ! remote_codex_path_exists "${backup}"; then
    echo "${kind}及其备份均不存在，跳过。"
    return 0
  fi

  case "${kind}" in
    "开发版命令")
      if ! remote_codex_launcher_belongs_to_source "${backup}" "${SOURCE_DIR}"; then
        echo "错误：备份 ${backup} 不属于当前源码仓库，拒绝恢复。" >&2
        return 1
      fi
      ;;
    "开发版桌面入口")
      if ! remote_codex_desktop_belongs_to_source "${backup}" "${SOURCE_DIR}" "${LAUNCHER_PATH}"; then
        echo "错误：备份 ${backup} 不属于当前源码仓库，拒绝恢复。" >&2
        return 1
      fi
      ;;
  esac
}

validate_restore_target "${LAUNCHER_PATH}" "${LAUNCHER_BACKUP}" "开发版命令"
validate_restore_target "${DESKTOP_PATH}" "${DESKTOP_BACKUP}" "开发版桌面入口"

RESTORED_LAUNCHER=0
if remote_codex_path_exists "${LAUNCHER_BACKUP}"; then
  mv "${LAUNCHER_BACKUP}" "${LAUNCHER_PATH}"
  RESTORED_LAUNCHER=1
  echo "已恢复开发版命令：${LAUNCHER_PATH}"
fi

if remote_codex_path_exists "${DESKTOP_BACKUP}"; then
  if ! mv "${DESKTOP_BACKUP}" "${DESKTOP_PATH}"; then
    if [ "${RESTORED_LAUNCHER}" -eq 1 ] && ! remote_codex_path_exists "${LAUNCHER_BACKUP}"; then
      mv "${LAUNCHER_PATH}" "${LAUNCHER_BACKUP}" || true
    fi
    echo "错误：恢复桌面入口失败；已尝试重新屏蔽开发版命令。" >&2
    exit 1
  fi
  echo "已恢复开发版桌面入口：${DESKTOP_PATH}"
fi

remote_codex_refresh_desktop_database "$(dirname "${DESKTOP_PATH}")"
echo "开发版启动入口已恢复。"
