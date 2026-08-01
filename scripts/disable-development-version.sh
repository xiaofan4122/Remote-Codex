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

validate_disable_target() {
  local current="$1"
  local backup="$2"
  local kind="$3"

  if remote_codex_path_exists "${current}" && remote_codex_path_exists "${backup}"; then
    echo "错误：${kind}及其备份同时存在，拒绝覆盖：${backup}" >&2
    return 1
  fi
  if remote_codex_path_exists "${backup}"; then
    echo "${kind}已经处于屏蔽状态：${backup}"
    return 0
  fi
  if ! remote_codex_path_exists "${current}"; then
    echo "${kind}不存在，跳过：${current}"
    return 0
  fi

  case "${kind}" in
    "开发版命令")
      if ! remote_codex_launcher_belongs_to_source "${current}" "${SOURCE_DIR}"; then
        echo "错误：${current} 不属于当前源码仓库，拒绝移动。" >&2
        return 1
      fi
      ;;
    "开发版桌面入口")
      if ! remote_codex_desktop_belongs_to_source "${current}" "${SOURCE_DIR}" "${LAUNCHER_PATH}"; then
        echo "错误：${current} 不属于当前源码仓库，拒绝移动。" >&2
        return 1
      fi
      ;;
  esac
}

validate_disable_target "${LAUNCHER_PATH}" "${LAUNCHER_BACKUP}" "开发版命令"
validate_disable_target "${DESKTOP_PATH}" "${DESKTOP_BACKUP}" "开发版桌面入口"
remote_codex_stop_source_processes "${SOURCE_DIR}"

MOVED_LAUNCHER=0
if remote_codex_path_exists "${LAUNCHER_PATH}"; then
  mv "${LAUNCHER_PATH}" "${LAUNCHER_BACKUP}"
  MOVED_LAUNCHER=1
  echo "已屏蔽开发版命令：${LAUNCHER_BACKUP}"
fi

if remote_codex_path_exists "${DESKTOP_PATH}"; then
  if ! mv "${DESKTOP_PATH}" "${DESKTOP_BACKUP}"; then
    if [ "${MOVED_LAUNCHER}" -eq 1 ] && ! remote_codex_path_exists "${LAUNCHER_PATH}"; then
      mv "${LAUNCHER_BACKUP}" "${LAUNCHER_PATH}" || true
    fi
    echo "错误：屏蔽桌面入口失败；已尝试恢复开发版命令。" >&2
    exit 1
  fi
  echo "已屏蔽开发版桌面入口：${DESKTOP_BACKUP}"
fi

remote_codex_refresh_desktop_database "$(dirname "${DESKTOP_PATH}")"
echo "开发版已屏蔽，可以启动 .deb 安装版 Remote Codex。"
