#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_CODEX_REPOSITORY="${REMOTE_CODEX_REPOSITORY:-xiaofan4122/Remote-Codex}"
REMOTE_CODEX_REQUESTED_VERSION="${REMOTE_CODEX_VERSION:-latest}"
REMOTE_CODEX_INSTALL_ROOT="${REMOTE_CODEX_INSTALL_ROOT:-${HOME}/.local/opt/remote-codex}"
REMOTE_CODEX_BIN_DIR="${REMOTE_CODEX_BIN_DIR:-${HOME}/.local/bin}"
REMOTE_CODEX_DESKTOP_DIR="${REMOTE_CODEX_DESKTOP_DIR:-${HOME}/.local/share/applications}"
REMOTE_CODEX_SKILL_HOME="${REMOTE_CODEX_CODEX_HOME_DIR:-${CODEX_HOME:-${HOME}/.codex}}"
REMOTE_CODEX_SKIP_DESKTOP="${REMOTE_CODEX_SKIP_DESKTOP:-0}"
REMOTE_CODEX_TEMP_DIR=""
REMOTE_CODEX_STAGE_DIR=""
REMOTE_CODEX_TOTAL_STAGES=8

usage() {
  cat <<'EOF'
Install the latest Remote Codex Linux release for the current user.

Usage:
  ./install.sh [--version VERSION] [--no-desktop]

Environment overrides for managed deployments:
  REMOTE_CODEX_INSTALL_ROOT
  REMOTE_CODEX_BIN_DIR
  REMOTE_CODEX_DESKTOP_DIR
  REMOTE_CODEX_CODEX_HOME_DIR
  REMOTE_CODEX_PROGRESS=auto|always|never
EOF
}

fail() {
  printf 'remote-codex installer: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

stage() {
  local remote_codex_number="$1"
  shift
  if [ "${remote_codex_number}" -gt 1 ]; then
    printf '\n'
  fi
  note "[${remote_codex_number}/${REMOTE_CODEX_TOTAL_STAGES}] $*"
}

detail() {
  printf '    %s\n' "$*"
}

progress_enabled() {
  case "${REMOTE_CODEX_PROGRESS:-auto}" in
    always) return 0 ;;
    never) return 1 ;;
    auto|'') [ -t 2 ] ;;
    *) fail 'REMOTE_CODEX_PROGRESS must be auto, always, or never' ;;
  esac
}

file_size() {
  local remote_codex_file="$1"
  local remote_codex_bytes
  remote_codex_bytes="$(wc -c < "${remote_codex_file}" | tr -d '[:space:]')"
  awk -v bytes="${remote_codex_bytes}" 'BEGIN {
    if (bytes >= 1073741824) printf "%.1f GiB", bytes / 1073741824
    else if (bytes >= 1048576) printf "%.1f MiB", bytes / 1048576
    else if (bytes >= 1024) printf "%.1f KiB", bytes / 1024
    else printf "%d bytes", bytes
  }'
}

cleanup() {
  if [ -n "${REMOTE_CODEX_TEMP_DIR}" ] && [ -d "${REMOTE_CODEX_TEMP_DIR}" ]; then
    rm -rf -- "${REMOTE_CODEX_TEMP_DIR}"
  fi
  if [ -n "${REMOTE_CODEX_STAGE_DIR}" ] && [ -d "${REMOTE_CODEX_STAGE_DIR}" ]; then
    rm -rf -- "${REMOTE_CODEX_STAGE_DIR}"
  fi
}

trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail '--version requires a value'
      REMOTE_CODEX_REQUESTED_VERSION="$2"
      shift 2
      ;;
    --no-desktop)
      REMOTE_CODEX_SKIP_DESKTOP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ "$(uname -s)" = 'Linux' ] || fail 'Remote Codex supports Linux only'

stage 1 'Checking system compatibility'
detail "Operating system: $(uname -s)"

case "${REMOTE_CODEX_INSTALL_ROOT}" in
  /*) ;;
  *) fail 'REMOTE_CODEX_INSTALL_ROOT must be an absolute path' ;;
esac

case "${REMOTE_CODEX_INSTALL_ROOT%/}" in
  ''|'/'|"${HOME}"|"${HOME}/.local"|"${HOME}/.local/opt")
    fail 'refusing to use a broad install root'
    ;;
esac

REMOTE_CODEX_MACHINE_ARCH="${REMOTE_CODEX_ARCH:-$(uname -m)}"
case "${REMOTE_CODEX_MACHINE_ARCH}" in
  x86_64|amd64|x64)
    REMOTE_CODEX_RELEASE_ARCH=x64
    ;;
  aarch64|arm64)
    REMOTE_CODEX_RELEASE_ARCH=arm64
    ;;
  *)
    fail "unsupported Linux architecture: ${REMOTE_CODEX_MACHINE_ARCH}"
    ;;
esac

detail "Architecture: ${REMOTE_CODEX_MACHINE_ARCH} -> release ${REMOTE_CODEX_RELEASE_ARCH}"
detail "Install root: ${REMOTE_CODEX_INSTALL_ROOT}"

for REMOTE_CODEX_REQUIRED_COMMAND in tar sha256sum awk sed find mktemp wc tr; do
  command -v "${REMOTE_CODEX_REQUIRED_COMMAND}" >/dev/null 2>&1 ||
    fail "required command not found: ${REMOTE_CODEX_REQUIRED_COMMAND}"
done
detail 'Required system tools are available'

download_file() {
  local remote_codex_url="$1"
  local remote_codex_destination="$2"
  local remote_codex_label="$3"

  detail "${remote_codex_label}"
  detail "Source: ${remote_codex_url}"

  case "${remote_codex_url}" in
    file://*)
      cp -- "${remote_codex_url#file://}" "${remote_codex_destination}"
      ;;
    https://*) ;;
    *) fail "refusing non-HTTPS download URL: ${remote_codex_url}" ;;
  esac

  if [[ "${remote_codex_url}" == https://* ]]; then
    if command -v curl >/dev/null 2>&1; then
      local remote_codex_curl_args=(
        --proto '=https'
        --tlsv1.2
        --fail
        --location
        --show-error
        --retry 3
        --retry-delay 2
        --connect-timeout 15
        --speed-limit 1024
        --speed-time 30
        --output "${remote_codex_destination}"
      )
      if progress_enabled; then
        detail 'Progress:'
        if ! curl "${remote_codex_curl_args[@]}" "${remote_codex_url}"; then
          fail "download failed after retries: ${remote_codex_label}"
        fi
      else
        if ! curl "${remote_codex_curl_args[@]}" --silent "${remote_codex_url}"; then
          fail "download failed after retries: ${remote_codex_label}"
        fi
      fi
    elif command -v wget >/dev/null 2>&1; then
      if progress_enabled; then
        detail 'Progress:'
        if ! wget --https-only --timeout=30 --tries=4 --progress=bar:force:noscroll \
          --output-document="${remote_codex_destination}" "${remote_codex_url}"; then
          fail "download failed after retries: ${remote_codex_label}"
        fi
      else
        if ! wget --https-only --timeout=30 --tries=4 --quiet \
          --output-document="${remote_codex_destination}" "${remote_codex_url}"; then
          fail "download failed after retries: ${remote_codex_label}"
        fi
      fi
    else
      fail 'curl or wget is required'
    fi
  fi

  [ -s "${remote_codex_destination}" ] || fail "downloaded file is empty: ${remote_codex_label}"
  detail "Download complete: $(file_size "${remote_codex_destination}")"
}

normalize_version() {
  local remote_codex_version="${1#v}"
  if [[ ! "${remote_codex_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
    fail "invalid release version: $1"
  fi
  printf '%s' "${remote_codex_version}"
}

REMOTE_CODEX_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/remote-codex-install.XXXXXX")"

stage 2 'Resolving the release version'

if [ -n "${REMOTE_CODEX_DOWNLOAD_BASE:-}" ]; then
  REMOTE_CODEX_RELEASE_BASE="${REMOTE_CODEX_DOWNLOAD_BASE%/}"
elif [ "${REMOTE_CODEX_REQUESTED_VERSION}" = 'latest' ]; then
  REMOTE_CODEX_RELEASE_BASE="https://github.com/${REMOTE_CODEX_REPOSITORY}/releases/latest/download"
else
  REMOTE_CODEX_NORMALIZED_REQUEST="$(normalize_version "${REMOTE_CODEX_REQUESTED_VERSION}")"
  REMOTE_CODEX_RELEASE_BASE="https://github.com/${REMOTE_CODEX_REPOSITORY}/releases/download/v${REMOTE_CODEX_NORMALIZED_REQUEST}"
fi

if [ "${REMOTE_CODEX_REQUESTED_VERSION}" = 'latest' ]; then
  download_file \
    "${REMOTE_CODEX_RELEASE_BASE}/remote-codex-version.txt" \
    "${REMOTE_CODEX_TEMP_DIR}/version.txt" \
    'Downloading latest-version metadata'
  REMOTE_CODEX_RELEASE_VERSION="$(normalize_version "$(sed -n '1p' "${REMOTE_CODEX_TEMP_DIR}/version.txt" | tr -d '[:space:]')")"
else
  REMOTE_CODEX_RELEASE_VERSION="$(normalize_version "${REMOTE_CODEX_REQUESTED_VERSION}")"
fi
detail "Resolved version: ${REMOTE_CODEX_RELEASE_VERSION}"

REMOTE_CODEX_ASSET="remote-codex-linux-${REMOTE_CODEX_RELEASE_ARCH}.tar.gz"
REMOTE_CODEX_ARCHIVE="${REMOTE_CODEX_TEMP_DIR}/${REMOTE_CODEX_ASSET}"
REMOTE_CODEX_CHECKSUM_FILE="${REMOTE_CODEX_ARCHIVE}.sha256"

stage 3 "Downloading Remote Codex ${REMOTE_CODEX_RELEASE_VERSION}"
detail "Asset: ${REMOTE_CODEX_ASSET}"
download_file \
  "${REMOTE_CODEX_RELEASE_BASE}/${REMOTE_CODEX_ASSET}" \
  "${REMOTE_CODEX_ARCHIVE}" \
  'Downloading application archive'
download_file \
  "${REMOTE_CODEX_RELEASE_BASE}/${REMOTE_CODEX_ASSET}.sha256" \
  "${REMOTE_CODEX_CHECKSUM_FILE}" \
  'Downloading SHA-256 checksum'

stage 4 'Verifying release integrity'
REMOTE_CODEX_EXPECTED_SHA256="$(awk 'NR == 1 { print tolower($1) }' "${REMOTE_CODEX_CHECKSUM_FILE}")"
[[ "${REMOTE_CODEX_EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]] || fail 'release checksum is invalid'
REMOTE_CODEX_ACTUAL_SHA256="$(sha256sum "${REMOTE_CODEX_ARCHIVE}" | awk '{ print tolower($1) }')"
[ "${REMOTE_CODEX_ACTUAL_SHA256}" = "${REMOTE_CODEX_EXPECTED_SHA256}" ] || fail 'release checksum verification failed'
detail "SHA-256 verified: ${REMOTE_CODEX_ACTUAL_SHA256}"

stage 5 'Inspecting and extracting the archive'
detail 'Checking archive paths before extraction'
while IFS= read -r REMOTE_CODEX_ARCHIVE_ENTRY; do
  case "${REMOTE_CODEX_ARCHIVE_ENTRY}" in
    /*|../*|*/../*|*/..)
      fail "unsafe archive entry: ${REMOTE_CODEX_ARCHIVE_ENTRY}"
      ;;
  esac
done < <(tar -tzf "${REMOTE_CODEX_ARCHIVE}")

mkdir -p "${REMOTE_CODEX_TEMP_DIR}/unpack"
tar -xzf "${REMOTE_CODEX_ARCHIVE}" -C "${REMOTE_CODEX_TEMP_DIR}/unpack"
detail 'Archive extracted successfully'

if [ -f "${REMOTE_CODEX_TEMP_DIR}/unpack/remote-codex" ]; then
  REMOTE_CODEX_APP_DIR="${REMOTE_CODEX_TEMP_DIR}/unpack"
else
  mapfile -t REMOTE_CODEX_BINARY_CANDIDATES < <(
    find "${REMOTE_CODEX_TEMP_DIR}/unpack" -mindepth 2 -maxdepth 2 \
      -type f -name remote-codex
  )
  [ "${#REMOTE_CODEX_BINARY_CANDIDATES[@]}" -eq 1 ] ||
    fail 'release archive does not contain one Remote Codex application'
  REMOTE_CODEX_APP_DIR="$(dirname "${REMOTE_CODEX_BINARY_CANDIDATES[0]}")"
fi

[ -f "${REMOTE_CODEX_APP_DIR}/remote-codex" ] || fail 'release executable is missing'
[ -d "${REMOTE_CODEX_APP_DIR}/resources" ] || fail 'release resources are missing'
chmod +x "${REMOTE_CODEX_APP_DIR}/remote-codex"

REMOTE_CODEX_RELEASE_ID="${REMOTE_CODEX_RELEASE_VERSION}-${REMOTE_CODEX_RELEASE_ARCH}-${REMOTE_CODEX_EXPECTED_SHA256:0:12}"
REMOTE_CODEX_RELEASES_DIR="${REMOTE_CODEX_INSTALL_ROOT}/releases"
REMOTE_CODEX_RELEASE_DIR="${REMOTE_CODEX_RELEASES_DIR}/${REMOTE_CODEX_RELEASE_ID}"
mkdir -p "${REMOTE_CODEX_RELEASES_DIR}" "${REMOTE_CODEX_BIN_DIR}"

stage 6 'Installing application files atomically'
if [ ! -d "${REMOTE_CODEX_RELEASE_DIR}" ]; then
  detail "Staging release: ${REMOTE_CODEX_RELEASE_ID}"
  REMOTE_CODEX_STAGE_DIR="$(mktemp -d "${REMOTE_CODEX_INSTALL_ROOT}/.stage.XXXXXX")"
  cp -a "${REMOTE_CODEX_APP_DIR}/." "${REMOTE_CODEX_STAGE_DIR}/"
  mv "${REMOTE_CODEX_STAGE_DIR}" "${REMOTE_CODEX_RELEASE_DIR}"
  REMOTE_CODEX_STAGE_DIR=""
else
  detail "Release already present; reusing ${REMOTE_CODEX_RELEASE_ID}"
fi

REMOTE_CODEX_NEXT_LINK="${REMOTE_CODEX_INSTALL_ROOT}/.current.$$.new"
ln -s "releases/${REMOTE_CODEX_RELEASE_ID}" "${REMOTE_CODEX_NEXT_LINK}"
mv -Tf "${REMOTE_CODEX_NEXT_LINK}" "${REMOTE_CODEX_INSTALL_ROOT}/current"
detail "Activated release: ${REMOTE_CODEX_RELEASE_DIR}"

install_managed_link() {
  local remote_codex_target="$1"
  local remote_codex_link="$2"
  if [ -e "${remote_codex_link}" ] && [ ! -L "${remote_codex_link}" ]; then
    fail "refusing to replace non-symlink path: ${remote_codex_link}"
  fi
  ln -sfn "${remote_codex_target}" "${remote_codex_link}"
}

stage 7 'Installing command and desktop integrations'
install_managed_link \
  "${REMOTE_CODEX_INSTALL_ROOT}/current/remote-codex" \
  "${REMOTE_CODEX_BIN_DIR}/remote-codex"
detail "Command: ${REMOTE_CODEX_BIN_DIR}/remote-codex"

REMOTE_CODEX_UNINSTALL_SOURCE="${REMOTE_CODEX_INSTALL_ROOT}/current/resources/install/uninstall-linux.sh"
if [ -f "${REMOTE_CODEX_UNINSTALL_SOURCE}" ]; then
  chmod +x "${REMOTE_CODEX_UNINSTALL_SOURCE}"
  install_managed_link \
    "${REMOTE_CODEX_UNINSTALL_SOURCE}" \
    "${REMOTE_CODEX_BIN_DIR}/remote-codex-uninstall"
  detail "Uninstaller: ${REMOTE_CODEX_BIN_DIR}/remote-codex-uninstall"
fi

REMOTE_CODEX_SKILL_SOURCE="${REMOTE_CODEX_INSTALL_ROOT}/current/resources/skills/remote-codex-send-files"
REMOTE_CODEX_SKILL_DIR="${REMOTE_CODEX_SKILL_HOME}/skills/remote-codex-send-files"
if [ -f "${REMOTE_CODEX_SKILL_SOURCE}/SKILL.md" ] &&
   [ -f "${REMOTE_CODEX_SKILL_SOURCE}/agents/openai.yaml" ]; then
  if [ -L "${REMOTE_CODEX_SKILL_DIR}" ] || [ -L "${REMOTE_CODEX_SKILL_DIR}/agents" ]; then
    fail "refusing to replace symlinked skill path: ${REMOTE_CODEX_SKILL_DIR}"
  fi
  mkdir -p "${REMOTE_CODEX_SKILL_DIR}/agents"
  install -m 0644 "${REMOTE_CODEX_SKILL_SOURCE}/SKILL.md" "${REMOTE_CODEX_SKILL_DIR}/SKILL.md"
  install -m 0644 "${REMOTE_CODEX_SKILL_SOURCE}/agents/openai.yaml" "${REMOTE_CODEX_SKILL_DIR}/agents/openai.yaml"
  printf 'repository=%s\nversion=%s\n' \
    "${REMOTE_CODEX_REPOSITORY}" "${REMOTE_CODEX_RELEASE_VERSION}" \
    > "${REMOTE_CODEX_SKILL_DIR}/.remote-codex-managed"
  chmod 0600 "${REMOTE_CODEX_SKILL_DIR}/.remote-codex-managed"
  detail "Bundled Codex skill: ${REMOTE_CODEX_SKILL_DIR}"
fi

if [ "${REMOTE_CODEX_SKIP_DESKTOP}" != '1' ]; then
  mkdir -p "${REMOTE_CODEX_DESKTOP_DIR}"
  REMOTE_CODEX_DESKTOP_FILE="${REMOTE_CODEX_DESKTOP_DIR}/remote-codex.desktop"
  REMOTE_CODEX_DESKTOP_TEMP="${REMOTE_CODEX_TEMP_DIR}/remote-codex.desktop"
  REMOTE_CODEX_DESKTOP_BIN="$(printf '%s' "${REMOTE_CODEX_BIN_DIR}/remote-codex" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g')"
  cat > "${REMOTE_CODEX_DESKTOP_TEMP}" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Remote Codex
Comment=Control the native Codex CLI locally and from Feishu
Exec=env REMOTE_CODEX_USE_CONFIG_DEFAULT_CWD=1 "${REMOTE_CODEX_DESKTOP_BIN}"
Icon=${REMOTE_CODEX_INSTALL_ROOT}/current/resources/icon.png
Terminal=false
Categories=Development;Utility;
StartupNotify=true
X-Remote-Codex-Managed=true
EOF
  install -m 0644 "${REMOTE_CODEX_DESKTOP_TEMP}" "${REMOTE_CODEX_DESKTOP_FILE}"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${REMOTE_CODEX_DESKTOP_DIR}" >/dev/null 2>&1 || true
  fi
  detail "Desktop entry: ${REMOTE_CODEX_DESKTOP_FILE}"
else
  detail 'Desktop entry: skipped (--no-desktop)'
fi

stage 8 'Installation complete'
note "Installed Remote Codex ${REMOTE_CODEX_RELEASE_VERSION}"
printf '    command: %s\n' "${REMOTE_CODEX_BIN_DIR}/remote-codex"
printf '    files:   %s\n' "${REMOTE_CODEX_RELEASE_DIR}"

case ":${PATH}:" in
  *":${REMOTE_CODEX_BIN_DIR}:"*) ;;
  *)
    printf '\nAdd this directory to PATH before using the command:\n'
    printf '    export PATH="%s:$PATH"\n' "${REMOTE_CODEX_BIN_DIR}"
    ;;
esac

if command -v codex >/dev/null 2>&1; then
  printf '\nCodex CLI detected: '
  codex --version 2>/dev/null || printf '%s\n' "$(command -v codex)"
else
  printf '\nCodex CLI was not found on PATH. Install and sign in to Codex before starting Remote Codex.\n'
  printf 'Official setup: https://developers.openai.com/codex/cli/\n'
fi

printf '\nStart with:\n    remote-codex\n'
