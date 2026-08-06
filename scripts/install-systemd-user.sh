#!/usr/bin/env bash
# 安装为当前用户的 systemd 服务：开机/登录后自动在后台跑 npm run dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_NAME="ailunwen-dev.service"
TEMPLATE="$ROOT/deploy/ailunwen-dev.service"
TARGET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TARGET="$TARGET_DIR/$UNIT_NAME"

NODE_BIN="$(dirname "$(command -v node)")"
NPM_BIN="$(command -v npm)"

mkdir -p "$TARGET_DIR"
sed \
  -e "s|%WORKDIR%|$ROOT|g" \
  -e "s|%NODE_BIN%|$NODE_BIN|g" \
  -e "s|%NPM_BIN%|$NPM_BIN|g" \
  "$TEMPLATE" >"$TARGET"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"
systemctl --user restart "$UNIT_NAME"

echo ""
echo "已安装并启动：$UNIT_NAME"
echo "  状态：  systemctl --user status $UNIT_NAME"
echo "  日志：  journalctl --user -u $UNIT_NAME -f"
echo "  停止：  systemctl --user stop $UNIT_NAME"
echo "  禁用：  systemctl --user disable $UNIT_NAME"
echo ""
echo "若希望「未登录也常驻」，执行一次："
echo "  loginctl enable-linger \"$USER\""
