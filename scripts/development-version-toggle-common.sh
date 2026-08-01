#!/usr/bin/env bash

# Shared implementation for temporarily hiding the source-development launchers.
# This file is sourced by disable/restore-development-version.sh.

REMOTE_CODEX_LAUNCHER_RELATIVE_PATH=".local/bin/remote-codex"
REMOTE_CODEX_DESKTOP_RELATIVE_PATH=".local/share/applications/remote-codex.desktop"
REMOTE_CODEX_BACKUP_SUFFIX=".development-disabled"

remote_codex_resolve_source_dir() {
  local script_path script_dir candidate launcher candidate_line

  if [ -n "${REMOTE_CODEX_SOURCE_DIR:-}" ]; then
    candidate="${REMOTE_CODEX_SOURCE_DIR}"
  else
    script_path="$(readlink -f "${BASH_SOURCE[1]}")" || return 1
    script_dir="$(cd "$(dirname "${script_path}")" && pwd)" || return 1
    candidate="$(cd "${script_dir}/.." && pwd)" || return 1

    if ! remote_codex_is_source_tree "${candidate}"; then
      for launcher in \
        "${HOME}/${REMOTE_CODEX_LAUNCHER_RELATIVE_PATH}" \
        "${HOME}/${REMOTE_CODEX_LAUNCHER_RELATIVE_PATH}${REMOTE_CODEX_BACKUP_SUFFIX}"; do
        [ -f "${launcher}" ] || continue
        candidate_line="$(sed -n 's/^APP_DIR="\([^"]*\)"$/\1/p' "${launcher}" | head -n 1)"
        if [ -n "${candidate_line}" ] && remote_codex_is_source_tree "${candidate_line}"; then
          candidate="${candidate_line}"
          break
        fi
      done
    fi
  fi

  if ! remote_codex_is_source_tree "${candidate}"; then
    echo "错误：无法确认 Remote Codex 源码目录：${candidate}" >&2
    echo "可通过 REMOTE_CODEX_SOURCE_DIR=/源码绝对路径 明确指定。" >&2
    return 1
  fi

  (cd "${candidate}" && pwd)
}

remote_codex_is_source_tree() {
  local candidate="$1"
  [ -d "${candidate}" ] &&
    [ -f "${candidate}/package.json" ] &&
    [ -f "${candidate}/scripts/start-electron.sh" ] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"remote-codex"' "${candidate}/package.json"
}

remote_codex_launcher_belongs_to_source() {
  local path="$1"
  local source_dir="$2"
  [ -f "${path}" ] && grep -Fqx "APP_DIR=\"${source_dir}\"" "${path}"
}

remote_codex_desktop_belongs_to_source() {
  local path="$1"
  local source_dir="$2"
  local launcher_path="$3"
  [ -f "${path}" ] &&
    grep -Fqx "Exec=${launcher_path}" "${path}" &&
    grep -Fq "${source_dir}/" "${path}"
}

remote_codex_path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

remote_codex_refresh_desktop_database() {
  local desktop_dir="$1"
  [ -d "${desktop_dir}" ] || return 0
  if command -v update-desktop-database >/dev/null 2>&1; then
    if ! update-desktop-database "${desktop_dir}" >/dev/null 2>&1; then
      echo "错误：启动器已处理，但刷新桌面应用数据库失败：${desktop_dir}" >&2
      return 1
    fi
    echo "已刷新桌面应用数据库。"
  fi
}

remote_codex_process_belongs_to_source() {
  local pid="$1"
  local source_dir="$2"
  local proc_root="$3"
  local process_dir="${proc_root}/${pid}"
  local process_cwd process_exe argv0 argument
  local -a process_argv=()

  [ -d "${process_dir}" ] || return 1
  process_cwd="$(readlink -f "${process_dir}/cwd" 2>/dev/null || true)"
  process_exe="$(readlink -f "${process_dir}/exe" 2>/dev/null || true)"
  mapfile -d '' -t process_argv < "${process_dir}/cmdline" 2>/dev/null || true
  [ "${#process_argv[@]}" -gt 0 ] || return 1

  case "${process_exe}" in
    "${source_dir}/node_modules/electron/"*) return 0 ;;
  esac

  [ "${process_cwd}" = "${source_dir}" ] || return 1
  argv0="${process_argv[0]##*/}"
  case "${argv0}" in
    npm)
      [ "${process_argv[1]:-}" = "start" ] && return 0
      ;;
    "npm start")
      return 0
      ;;
    node)
      case "${process_argv[1]:-}" in
        */npm-cli.js)
          [ "${process_argv[2]:-}" = "start" ] && return 0
          ;;
      esac
      ;;
    bash|sh)
      for argument in "${process_argv[@]:1}"; do
        case "${argument}" in
          scripts/start-electron.sh|"${source_dir}/scripts/start-electron.sh") return 0 ;;
        esac
      done
      ;;
  esac

  return 1
}

remote_codex_stop_source_processes() {
  local source_dir="$1"
  local proc_root="${REMOTE_CODEX_PROC_ROOT:-/proc}"
  local kill_command="${REMOTE_CODEX_KILL_COMMAND:-kill}"
  local process_dir pid attempt remaining
  local -a source_pids=()

  for process_dir in "${proc_root}"/[0-9]*; do
    [ -d "${process_dir}" ] || continue
    pid="${process_dir##*/}"
    [ "${pid}" != "$$" ] || continue
    if remote_codex_process_belongs_to_source "${pid}" "${source_dir}" "${proc_root}"; then
      source_pids+=("${pid}")
    fi
  done

  if [ "${#source_pids[@]}" -eq 0 ]; then
    echo "未发现属于该源码仓库的 Remote Codex 开发版进程。"
    return 0
  fi

  echo "正在安全终止 ${#source_pids[@]} 个开发版进程……"
  for pid in "${source_pids[@]}"; do
    if ! "${kill_command}" -TERM "${pid}"; then
      if remote_codex_process_belongs_to_source "${pid}" "${source_dir}" "${proc_root}"; then
        echo "错误：无法向开发版进程 ${pid} 发送 TERM 信号。" >&2
        return 1
      fi
    fi
  done

  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    remaining=0
    for pid in "${source_pids[@]}"; do
      if remote_codex_process_belongs_to_source "${pid}" "${source_dir}" "${proc_root}"; then
        remaining=1
        break
      fi
    done
    [ "${remaining}" -eq 0 ] && break
    sleep 0.1
  done

  if [ "${remaining}" -ne 0 ]; then
    echo "错误：开发版进程未在 TERM 后退出；为避免误杀，未发送 KILL。" >&2
    return 1
  fi
  echo "开发版进程已退出。"
}
