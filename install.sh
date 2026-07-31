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
EOF
}

fail() {
  printf 'remote-codex installer: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
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

for REMOTE_CODEX_REQUIRED_COMMAND in tar sha256sum awk sed find mktemp; do
  command -v "${REMOTE_CODEX_REQUIRED_COMMAND}" >/dev/null 2>&1 ||
    fail "required command not found: ${REMOTE_CODEX_REQUIRED_COMMAND}"
done

download_file() {
  local remote_codex_url="$1"
  local remote_codex_destination="$2"

  case "${remote_codex_url}" in
    file://*)
      cp -- "${remote_codex_url#file://}" "${remote_codex_destination}"
      return
      ;;
    https://*) ;;
    *) fail "refusing non-HTTPS download URL: ${remote_codex_url}" ;;
  esac

  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      --retry 3 --output "${remote_codex_destination}" "${remote_codex_url}"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --quiet --output-document="${remote_codex_destination}" \
      "${remote_codex_url}"
  else
    fail 'curl or wget is required'
  fi
}

normalize_version() {
  local remote_codex_version="${1#v}"
  if [[ ! "${remote_codex_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
    fail "invalid release version: $1"
  fi
  printf '%s' "${remote_codex_version}"
}

REMOTE_CODEX_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/remote-codex-install.XXXXXX")"

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
    "${REMOTE_CODEX_TEMP_DIR}/version.txt"
  REMOTE_CODEX_RELEASE_VERSION="$(normalize_version "$(sed -n '1p' "${REMOTE_CODEX_TEMP_DIR}/version.txt" | tr -d '[:space:]')")"
else
  REMOTE_CODEX_RELEASE_VERSION="$(normalize_version "${REMOTE_CODEX_REQUESTED_VERSION}")"
fi

REMOTE_CODEX_ASSET="remote-codex-linux-${REMOTE_CODEX_RELEASE_ARCH}.tar.gz"
REMOTE_CODEX_ARCHIVE="${REMOTE_CODEX_TEMP_DIR}/${REMOTE_CODEX_ASSET}"
REMOTE_CODEX_CHECKSUM_FILE="${REMOTE_CODEX_ARCHIVE}.sha256"

note "Downloading Remote Codex ${REMOTE_CODEX_RELEASE_VERSION} for Linux ${REMOTE_CODEX_RELEASE_ARCH}"
download_file "${REMOTE_CODEX_RELEASE_BASE}/${REMOTE_CODEX_ASSET}" "${REMOTE_CODEX_ARCHIVE}"
download_file "${REMOTE_CODEX_RELEASE_BASE}/${REMOTE_CODEX_ASSET}.sha256" "${REMOTE_CODEX_CHECKSUM_FILE}"

REMOTE_CODEX_EXPECTED_SHA256="$(awk 'NR == 1 { print tolower($1) }' "${REMOTE_CODEX_CHECKSUM_FILE}")"
[[ "${REMOTE_CODEX_EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]] || fail 'release checksum is invalid'
REMOTE_CODEX_ACTUAL_SHA256="$(sha256sum "${REMOTE_CODEX_ARCHIVE}" | awk '{ print tolower($1) }')"
[ "${REMOTE_CODEX_ACTUAL_SHA256}" = "${REMOTE_CODEX_EXPECTED_SHA256}" ] || fail 'release checksum verification failed'
note 'Checksum verified'

while IFS= read -r REMOTE_CODEX_ARCHIVE_ENTRY; do
  case "${REMOTE_CODEX_ARCHIVE_ENTRY}" in
    /*|../*|*/../*|*/..)
      fail "unsafe archive entry: ${REMOTE_CODEX_ARCHIVE_ENTRY}"
      ;;
  esac
done < <(tar -tzf "${REMOTE_CODEX_ARCHIVE}")

mkdir -p "${REMOTE_CODEX_TEMP_DIR}/unpack"
tar -xzf "${REMOTE_CODEX_ARCHIVE}" -C "${REMOTE_CODEX_TEMP_DIR}/unpack"

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

if [ ! -d "${REMOTE_CODEX_RELEASE_DIR}" ]; then
  REMOTE_CODEX_STAGE_DIR="$(mktemp -d "${REMOTE_CODEX_INSTALL_ROOT}/.stage.XXXXXX")"
  cp -a "${REMOTE_CODEX_APP_DIR}/." "${REMOTE_CODEX_STAGE_DIR}/"
  mv "${REMOTE_CODEX_STAGE_DIR}" "${REMOTE_CODEX_RELEASE_DIR}"
  REMOTE_CODEX_STAGE_DIR=""
fi

REMOTE_CODEX_NEXT_LINK="${REMOTE_CODEX_INSTALL_ROOT}/.current.$$.new"
ln -s "releases/${REMOTE_CODEX_RELEASE_ID}" "${REMOTE_CODEX_NEXT_LINK}"
mv -Tf "${REMOTE_CODEX_NEXT_LINK}" "${REMOTE_CODEX_INSTALL_ROOT}/current"

install_managed_link() {
  local remote_codex_target="$1"
  local remote_codex_link="$2"
  if [ -e "${remote_codex_link}" ] && [ ! -L "${remote_codex_link}" ]; then
    fail "refusing to replace non-symlink path: ${remote_codex_link}"
  fi
  ln -sfn "${remote_codex_target}" "${remote_codex_link}"
}

install_managed_link \
  "${REMOTE_CODEX_INSTALL_ROOT}/current/remote-codex" \
  "${REMOTE_CODEX_BIN_DIR}/remote-codex"

REMOTE_CODEX_UNINSTALL_SOURCE="${REMOTE_CODEX_INSTALL_ROOT}/current/resources/install/uninstall-linux.sh"
if [ -f "${REMOTE_CODEX_UNINSTALL_SOURCE}" ]; then
  chmod +x "${REMOTE_CODEX_UNINSTALL_SOURCE}"
  install_managed_link \
    "${REMOTE_CODEX_UNINSTALL_SOURCE}" \
    "${REMOTE_CODEX_BIN_DIR}/remote-codex-uninstall"
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
fi

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
