#!/usr/bin/env bash
# 不用 systemd 时：nohup 后台启动（关闭终端后仍运行，但重启机器不会自启）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.run/dev.pid"
LOG_FILE="$ROOT/.run/dev.log"

mkdir -p "$ROOT/.run"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE")"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[start-bg] 已在运行 (PID $OLD_PID)。日志: $LOG_FILE"
    exit 0
  fi
fi

cd "$ROOT"
nohup npm run dev >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
echo "[start-bg] 已后台启动 PID $(cat "$PID_FILE")"
echo "[start-bg] 前端 http://127.0.0.1:5175  后端 http://127.0.0.1:8787"
echo "[start-bg] 日志: tail -f $LOG_FILE"
echo "[start-bg] 停止: npm run stop:bg"
