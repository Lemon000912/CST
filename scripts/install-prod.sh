#!/usr/bin/env bash
# 生产部署：编译前端 + 配置 Apache 虚拟主机 + 安装 API systemd 服务
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APACHE_TEMPLATE="$ROOT/deploy/apache-ailunwen.conf"
APACHE_TARGET="/etc/apache2/sites-available/ailunwen.conf"
API_UNIT_TEMPLATE="$ROOT/deploy/ailunwen-api.service"
API_UNIT_TARGET="/etc/systemd/system/ailunwen-api.service"

NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
LAN_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_IP="$(curl -fsS --connect-timeout 5 ifconfig.me 2>/dev/null || curl -fsS --connect-timeout 5 icanhazip.com 2>/dev/null || echo "")"

echo "[install-prod] 项目目录: $ROOT"
echo "[install-prod] 局域网 IP: $LAN_IP"
echo "[install-prod] 公网 IP: ${PUBLIC_IP:-（未检测到，请手动写入 ServerAlias）}"
echo "[install-prod] 编译前端..."
cd "$ROOT"
npm run build

echo "[install-prod] 配置 Apache（本机已有 Apache，不安装 Nginx）..."
sudo a2enmod proxy proxy_http rewrite 2>/dev/null || true
sudo sed \
  -e "s|__ROOT__|$ROOT|g" \
  -e "s|__LAN_IP__|$LAN_IP|g" \
  -e "s|__PUBLIC_IP__|${PUBLIC_IP:-$LAN_IP}|g" \
  "$APACHE_TEMPLATE" | sudo tee "$APACHE_TARGET" >/dev/null
sudo a2ensite ailunwen.conf
sudo apache2ctl configtest
sudo systemctl enable apache2
sudo systemctl reload apache2

echo "[install-prod] 安装 API systemd 服务..."
sudo sed \
  -e "s|%WORKDIR%|$ROOT|g" \
  -e "s|%NODE_BIN%|$NODE_DIR|g" \
  -e "s|%USER%|$USER|g" \
  "$API_UNIT_TEMPLATE" | sudo tee "$API_UNIT_TARGET" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable ailunwen-api.service
sudo systemctl restart ailunwen-api.service

echo ""
echo "=========================================="
echo " 生产部署完成（Apache）"
echo "=========================================="
echo " 本机访问:    http://127.0.0.1/"
echo " 局域网访问:  http://$LAN_IP/"
if [[ -n "$PUBLIC_IP" ]]; then
  echo " 公网访问:    http://$PUBLIC_IP:19014/  （端口以路由器 NAT 为准）"
fi
echo ""
echo " 若 80 端口已有其它站点（fish7.tech 等），请："
echo "   - 用域名访问：编辑 $APACHE_TARGET 改 ServerName"
echo "   - 或加 ServerAlias 你的公网 IP / 域名后: sudo systemctl reload apache2"
echo ""
echo " 还需完成（才能公网访问）："
echo "   1. sudo ufw allow 80/tcp"
echo "   2. 路由器端口转发: 外网 80 → $LAN_IP:80"
echo "   3. 确认运营商给了公网 IP（见部署教程）"
echo ""
echo " 常用命令:"
echo "   sudo systemctl status ailunwen-api apache2"
echo "   sudo systemctl restart ailunwen-api"
echo "   sudo systemctl reload apache2"
echo "   sudo journalctl -u ailunwen-api -f"
echo "   sudo tail -f /var/log/apache2/ailunwen-error.log"
echo "=========================================="
