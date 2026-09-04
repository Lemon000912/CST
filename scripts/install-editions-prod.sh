#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHOOL_DOMAIN="${SCHOOL_DOMAIN:-}"
ENTERPRISE_DOMAIN="${ENTERPRISE_DOMAIN:-}"
SECRETS_DIR="${AILUNWEN_SECRETS_DIR:-/home/ubuntu/ailunwen-secrets}"

if [[ -z "$SCHOOL_DOMAIN" || -z "$ENTERPRISE_DOMAIN" ]]; then
  echo "请设置 SCHOOL_DOMAIN 和 ENTERPRISE_DOMAIN 后重试。"
  echo "示例: SCHOOL_DOMAIN=school.example.com ENTERPRISE_DOMAIN=enterprise.example.com npm run install:editions"
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
APACHE_TARGET="/etc/apache2/sites-available/ailunwen-editions.conf"

cd "$ROOT"
npm run build:all

sudo a2enmod proxy proxy_http rewrite headers 2>/dev/null || true
sudo sed \
  -e "s|__ROOT__|$ROOT|g" \
  -e "s|__SCHOOL_DOMAIN__|$SCHOOL_DOMAIN|g" \
  -e "s|__ENTERPRISE_DOMAIN__|$ENTERPRISE_DOMAIN|g" \
  "$ROOT/deploy/apache-ailunwen-editions.conf" | sudo tee "$APACHE_TARGET" >/dev/null

for edition in school enterprise; do
  template="$ROOT/deploy/ailunwen-${edition}-api.service"
  target="/etc/systemd/system/ailunwen-${edition}-api.service"
  sudo sed \
    -e "s|%WORKDIR%|$ROOT|g" \
    -e "s|%NODE_BIN%|$NODE_DIR|g" \
    -e "s|%USER%|$USER|g" \
    -e "s|%SECRETS_DIR%|$SECRETS_DIR|g" \
    "$template" | sudo tee "$target" >/dev/null
done

sudo sed \
  -e "s|%WORKDIR%|$ROOT|g" \
  -e "s|%NODE_BIN%|$NODE_DIR|g" \
  -e "s|%USER%|$USER|g" \
  -e "s|/home/ubuntu/ailunwen-secrets|$SECRETS_DIR|g" \
  "$ROOT/deploy/ailunwen-pdf-sync.service" \
  | sudo tee "/etc/systemd/system/ailunwen-pdf-sync.service" >/dev/null

sudo a2dissite ailunwen.conf 2>/dev/null || true
sudo a2ensite ailunwen-editions.conf
sudo apache2ctl configtest

if sudo systemctl is-active --quiet ailunwen-api.service; then
  sudo systemctl disable --now ailunwen-api.service
fi

sudo systemctl daemon-reload
sudo systemctl enable --now ailunwen-school-api.service
sudo systemctl enable --now ailunwen-enterprise-api.service
sudo systemctl enable --now ailunwen-pdf-sync.service
sudo systemctl enable apache2
sudo systemctl reload apache2

echo "双版本部署完成："
echo "  校园版: http://$SCHOOL_DOMAIN"
echo "  企业版: http://$ENTERPRISE_DOMAIN"
echo "请分别配置 HTTPS，并检查微信开放平台的两个回调域名。"
