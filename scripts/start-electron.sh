#!/usr/bin/env bash
set -euo pipefail

if command -v fcitx-remote >/dev/null 2>&1 && ! command -v fcitx5-remote >/dev/null 2>&1; then
  export GTK_IM_MODULE=fcitx
  export QT_IM_MODULE=fcitx
  export XMODIFIERS=@im=fcitx
elif command -v fcitx5-remote >/dev/null 2>&1; then
  export GTK_IM_MODULE=fcitx5
  export QT_IM_MODULE=fcitx5
  export XMODIFIERS=@im=fcitx5
elif pgrep -x ibus-daemon >/dev/null 2>&1; then
  export GTK_IM_MODULE=ibus
  export QT_IM_MODULE=ibus
  export XMODIFIERS=@im=ibus
fi

exec electron . "$@"
