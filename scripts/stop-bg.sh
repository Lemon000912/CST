#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.run/dev.pid"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
    echo "[stop-bg] 已结束 PID $PID"
  fi
  rm -f "$PID_FILE"
fi

node "$ROOT/scripts/dev-kill.mjs"
