#!/usr/bin/env bash
# 代码更新后：重新编译前端并重启 API
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run build
sudo systemctl restart ailunwen-api.service
sudo systemctl restart ailunwen-pdf-sync.service
sudo systemctl reload apache2

echo "[update-prod] 完成。访问 http://$(hostname -I | awk '{print $1}')/"
