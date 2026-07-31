#!/usr/bin/env bash
set -Eeuo pipefail

REMOTE_CODEX_BUILD_ARCH="${1:-}"
case "${REMOTE_CODEX_BUILD_ARCH}" in
  x64)
    REMOTE_CODEX_DEB_ARCH=amd64
    ;;
  arm64)
    REMOTE_CODEX_DEB_ARCH=arm64
    ;;
  *)
    printf 'Usage: %s <x64|arm64>\n' "$0" >&2
    exit 1
    ;;
esac

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for reproducible Linux release builds.\n' >&2
  exit 1
}

REMOTE_CODEX_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_CODEX_CONTAINER_IMAGE="${REMOTE_CODEX_BUILD_IMAGE:-node:22.22.1-bullseye}"
REMOTE_CODEX_BUILD_UID="$(id -u)"
REMOTE_CODEX_BUILD_GID="$(id -g)"
REMOTE_CODEX_BUILD_CACHE_ROOT="${REMOTE_CODEX_BUILD_CACHE_ROOT:-${XDG_CACHE_HOME:-${HOME}/.cache}/remote-codex-build}"
REMOTE_CODEX_NPM_CACHE="${REMOTE_CODEX_BUILD_CACHE_ROOT}/npm"
REMOTE_CODEX_ELECTRON_CACHE="${REMOTE_CODEX_BUILD_CACHE_ROOT}/electron"
REMOTE_CODEX_XDG_CACHE="${REMOTE_CODEX_BUILD_CACHE_ROOT}/xdg"
REMOTE_CODEX_ELECTRON_GYP_CACHE="${REMOTE_CODEX_ELECTRON_GYP_CACHE:-${HOME}/.electron-gyp}"
REMOTE_CODEX_BUILD_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/remote-codex-container-build.XXXXXX")"

cleanup_build_work_dir() {
  case "${REMOTE_CODEX_BUILD_WORK_DIR}" in
    "${TMPDIR:-/tmp}"/remote-codex-container-build.*)
      rm -rf -- "${REMOTE_CODEX_BUILD_WORK_DIR}"
      ;;
    *)
      printf 'Refusing to remove unexpected build directory: %s\n' "${REMOTE_CODEX_BUILD_WORK_DIR}" >&2
      ;;
  esac
}
trap cleanup_build_work_dir EXIT

mkdir -p \
  "${REMOTE_CODEX_PROJECT_ROOT}/dist" \
  "${REMOTE_CODEX_NPM_CACHE}" \
  "${REMOTE_CODEX_ELECTRON_CACHE}" \
  "${REMOTE_CODEX_XDG_CACHE}" \
  "${REMOTE_CODEX_ELECTRON_GYP_CACHE}"

# electron-builder/FPM can append Debian archive members when an old artifact
# is present. Remove only this architecture's known outputs before rebuilding.
rm -f -- \
  "${REMOTE_CODEX_PROJECT_ROOT}/dist/remote-codex-linux-${REMOTE_CODEX_BUILD_ARCH}.tar.gz" \
  "${REMOTE_CODEX_PROJECT_ROOT}/dist/remote-codex-linux-${REMOTE_CODEX_BUILD_ARCH}.tar.gz.sha256" \
  "${REMOTE_CODEX_PROJECT_ROOT}/dist/remote-codex-linux-${REMOTE_CODEX_DEB_ARCH}.deb" \
  "${REMOTE_CODEX_PROJECT_ROOT}/dist/remote-codex-linux-${REMOTE_CODEX_DEB_ARCH}.deb.sha256"

REMOTE_CODEX_DOCKER_NETWORK_ARGS=()
if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${ALL_PROXY:-}" ]; then
  REMOTE_CODEX_DOCKER_NETWORK_ARGS+=(--network host)
  for REMOTE_CODEX_PROXY_NAME in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY; do
    if [ -n "${!REMOTE_CODEX_PROXY_NAME:-}" ]; then
      REMOTE_CODEX_DOCKER_NETWORK_ARGS+=(--env "${REMOTE_CODEX_PROXY_NAME}")
    fi
  done
fi

run_release_build_container() {
  docker run --rm \
    --user "${REMOTE_CODEX_BUILD_UID}:${REMOTE_CODEX_BUILD_GID}" \
    "${REMOTE_CODEX_DOCKER_NETWORK_ARGS[@]}" \
    --env "REMOTE_CODEX_BUILD_ARCH=${REMOTE_CODEX_BUILD_ARCH}" \
    --env "REMOTE_CODEX_DEB_ARCH=${REMOTE_CODEX_DEB_ARCH}" \
    --env npm_config_cache=/tmp/remote-codex-npm-cache \
    --env ELECTRON_CACHE=/tmp/remote-codex-electron-cache \
    --env npm_config_devdir=/tmp/remote-codex-electron-gyp \
    --env XDG_CACHE_HOME=/tmp/remote-codex-cache \
    --volume "${REMOTE_CODEX_PROJECT_ROOT}:/source:ro" \
    --volume "${REMOTE_CODEX_BUILD_WORK_DIR}:/workspace" \
    --volume "${REMOTE_CODEX_PROJECT_ROOT}/dist:/output" \
    --volume "${REMOTE_CODEX_NPM_CACHE}:/tmp/remote-codex-npm-cache" \
    --volume "${REMOTE_CODEX_ELECTRON_CACHE}:/tmp/remote-codex-electron-cache" \
    --volume "${REMOTE_CODEX_ELECTRON_GYP_CACHE}:/tmp/remote-codex-electron-gyp" \
    --volume "${REMOTE_CODEX_XDG_CACHE}:/tmp/remote-codex-cache" \
    --workdir /workspace \
    "${REMOTE_CODEX_CONTAINER_IMAGE}" \
    bash -lc '
    set -Eeuo pipefail
    tar -C /source \
      --exclude=./.git \
      --exclude=./node_modules \
      --exclude=./dist \
      --exclude=./build/CMakeFiles \
      --exclude=./current-screen.png \
      -cf - . | tar -C /workspace -xf -
    npm ci
    npm run "dist:linux:${REMOTE_CODEX_BUILD_ARCH}"
    node scripts/create-linux-checksums.js "${REMOTE_CODEX_BUILD_ARCH}"
    cp -a \
      "dist/remote-codex-linux-${REMOTE_CODEX_BUILD_ARCH}.tar.gz" \
      "dist/remote-codex-linux-${REMOTE_CODEX_BUILD_ARCH}.tar.gz.sha256" \
      "dist/remote-codex-linux-${REMOTE_CODEX_DEB_ARCH}.deb" \
      "dist/remote-codex-linux-${REMOTE_CODEX_DEB_ARCH}.deb.sha256" \
      /output/
  '
}

REMOTE_CODEX_DOCKER_STATUS=0
run_release_build_container || REMOTE_CODEX_DOCKER_STATUS=$?
if [ "${REMOTE_CODEX_DOCKER_STATUS}" -eq 0 ]; then
  exit 0
fi
if [ "${REMOTE_CODEX_DOCKER_STATUS}" -ne 125 ]; then
  exit "${REMOTE_CODEX_DOCKER_STATUS}"
fi

# Exit 125 means Docker failed before the container command started. GitHub
# hosted runners can hit transient daemon or image-start failures, so retry
# that infrastructure-only case once without masking real build failures.
printf 'Docker could not start the release container; retrying once in 5 seconds.\n' >&2
sleep 5
run_release_build_container
