#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run build:all
sudo systemctl restart ailunwen-school-api.service
sudo systemctl restart ailunwen-enterprise-api.service
sudo systemctl restart ailunwen-pdf-sync.service
sudo systemctl reload apache2

echo "[update-editions] 校园版和企业版均已更新。"
