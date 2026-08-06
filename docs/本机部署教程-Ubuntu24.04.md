# 犀材探索 · 本机服务器部署教程（全网可访问）

> **机器**：Dell PowerEdge T430 · Ubuntu 24.04 · 项目路径 `/home/dell/ailunwen`  
> **Web 服务器**：**Apache 2**（本机已安装，与 `fish7.tech` 等站点共存，**不用 Nginx**）  
> **目标**：让**局域网 + 公网**上的其它电脑都能通过浏览器访问  
> **你的局域网 IP**：`192.168.1.100`（`hostname -I` 第一个地址）

---

## 部署和开发的区别

| | `npm run dev`（开发） | **本文部署（生产）** |
|--|----------------------|---------------------|
| 用途 | 自己写代码、调试 | 给别人长期访问 |
| 前端 | Vite 开发服 `:5175` | 编译后的静态文件 + **Apache `:80`** |
| 后端 | Node `:8787` | Node `:8787`（systemd 守护） |
| 外网 | 需额外开端口，不推荐 | **路由器转发 80 端口** |
| 对外地址 | `http://IP:5175` | **`http://公网IP/`** 或 `http://域名/` |

---

## 架构（部署完成后）

```
其它电脑浏览器
    │
    ├─ 局域网 → http://192.168.1.100/
    └─ 公网   → http://你的公网IP/  （路由器 80 → 192.168.1.100:80）
                    │
                    ▼
            Apache :80  ──/api、/admin──▶  Node 后端 :8787
                │                              │
           frontend/dist                   PostgreSQL
           （编译后的网页）                  material_kb
```

**只需对外暴露 80 端口**（HTTPS 用 443，见文末）。8787 不直接暴露到公网更安全。

---

## 目录

1. [部署前检查](#1-部署前检查)
2. [第一步：生产环境安全项（可选）](#2-第一步生产环境安全项可选公网对外开放时建议做)
3. [第二步：一键安装（Apache）](#3-第二步一键安装apache)
4. [第三步：防火墙放行](#4-第三步防火墙放行)
5. [第四步：路由器端口转发](#5-第四步路由器端口转发公网访问关键)
6. [Apache 与已有站点共存](#6-apache-与已有站点共存)
7. [访问地址一览](#7-访问地址一览)
8. [日常运维命令](#8-日常运维命令)
9. [代码更新后怎么重新部署](#9-代码更新后怎么重新部署)
10. [自检清单](#10-自检清单)
11. [常见问题](#11-常见问题)
12. [HTTPS（可选）](#12-https可选)
13. [没有公网 IP 怎么办](#13-没有公网-ip-怎么办)
14. [附录：开发模式 `npm run dev`](#14-附录开发模式-npm-run-dev)

---

## 1. 部署前检查

```bash
cd /home/dell/ailunwen

test -f .env && echo ".env OK"
sudo systemctl is-active postgresql    # active
sudo systemctl is-active apache2       # active（本机已有）
node -v
hostname -I    # 第一个 192.168.1.100
apache2 -v
```

确认 **PostgreSQL、Apache 在跑**，**`.env` 已存在**。

---

## 2. 第一步：生产环境安全项（可选，公网对外开放时建议做）

下面**不执行也能部署**；公网访问建议至少做 **② 改 admin 密码**。

### ① 关闭自动创建测试账号（可选）

```bash
cd /home/dell/ailunwen
grep -q '^SEED_DEV_ADMIN=' .env \
  && sed -i 's/^SEED_DEV_ADMIN=.*/SEED_DEV_ADMIN=0/' .env \
  || echo 'SEED_DEV_ADMIN=0' >> .env
```

### ② 修改 admin 登录密码（公网强烈建议）

```bash
cd /home/dell/ailunwen
read -s -p "新的 admin 密码: " NEW_PASS; echo
HASH=$(node -e "import('bcryptjs').then(async m=>console.log(await m.default.hash(process.argv[1],10)))" "$NEW_PASS")
psql "postgresql://postgres:123456@127.0.0.1:5432/material_kb" \
  -c "UPDATE users SET password_hash='$HASH' WHERE username='admin';"
echo "admin 密码已更新"
```

> `psql` 密码须与 `.env` 里 `DATABASE_URL` 一致。

### ③ 设置 JWT 签名密钥（公网建议）

```bash
cd /home/dell/ailunwen
JWT=$(openssl rand -hex 32)
grep -q '^JWT_SECRET=' .env \
  && sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT/" .env \
  || echo "JWT_SECRET=$JWT" >> .env
echo "已写入 JWT_SECRET"
```

改完 `.env` 后若 API 已跑：`sudo systemctl restart ailunwen-api`

---

## 3. 第二步：一键安装（Apache）

```bash
cd /home/dell/ailunwen
npm run install:prod
```

脚本会：

1. `npm run build` → `frontend/dist`
2. 写入 Apache 站点 `/etc/apache2/sites-available/ailunwen.conf`（**不装 Nginx**）
3. `a2enmod proxy proxy_http rewrite` + `a2ensite ailunwen`
4. 安装并启动 systemd 服务 `ailunwen-api`（`node backend/index.js`）
5. `systemctl reload apache2`

验证：

```bash
curl -s http://127.0.0.1/api/health    # "ok":true
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/
```

配置文件模板在项目里：`deploy/apache-ailunwen.conf`

---

## 4. 第三步：防火墙放行

```bash
sudo ufw allow 80/tcp
sudo ufw allow 22/tcp
sudo ufw status
```

不必对公网开放 5175、8787。

---

## 5. 第四步：路由器端口转发（公网访问关键）

| 项目 | 值 |
|------|-----|
| 外网端口 | `80` |
| 内网 IP | `192.168.1.100` |
| 内网端口 | `80` |
| 协议 | TCP |

手机关 WiFi 用流量访问 `http://你的公网IP/` 测试。

| 情况 | 能否直连 |
|------|----------|
| 路由器 WAN IP = 百度「我的 IP」 | ✅ |
| WAN 是内网地址或与「我的 IP」不一致 | ❌ 需公网 IP 或穿透，见 [第 13 节](#13-没有公网-ip-怎么办) |

---

## 6. Apache 与已有站点共存

本机已有 `fish7.tech`、`ce.cstdata.net` 等站点，**不会卸载 Apache**，只是新增 `ailunwen.conf`。

### 用 IP 访问（`http://192.168.1.100/`）

安装脚本会把 `ServerName` 设为局域网 IP。若打开仍是 Apache 默认页，编辑站点：

```bash
sudo nano /etc/apache2/sites-available/ailunwen.conf
```

确认有：

```apache
ServerName 192.168.1.100
ServerAlias localhost 127.0.0.1
```

公网 IP 访问时再加一行（把 IP 换成你的）：

```apache
ServerAlias 112.80.26.214
```

然后：

```bash
sudo apache2ctl configtest
sudo systemctl reload apache2
```

### 用域名访问（推荐，与 fish7.tech 一样）

```bash
sudo nano /etc/apache2/sites-available/ailunwen.conf
```

改成例如：

```apache
ServerName ailunwen.fish7.tech
# DocumentRoot、ProxyPass 等保持不变
```

DNS 添加 A 记录指向公网 IP，然后 `sudo systemctl reload apache2`。

### 手动安装 Apache 配置（不用脚本时）

```bash
cd /home/dell/ailunwen
npm run build
sudo a2enmod proxy proxy_http rewrite
sudo cp deploy/apache-ailunwen.conf /tmp/ailunwen.conf
sudo sed -i "s|/home/dell/ailunwen|$(pwd)|g;s|__LAN_IP__|$(hostname -I | awk '{print $1}')|g" /tmp/ailunwen.conf
sudo mv /tmp/ailunwen.conf /etc/apache2/sites-available/ailunwen.conf
sudo a2ensite ailunwen.conf
sudo apache2ctl configtest
sudo systemctl reload apache2
# API 服务仍用 npm run install:prod 里的 systemd 部分，或见 deploy/ailunwen-api.service
```

---

## 7. 访问地址一览

| 谁访问 | 地址 |
|--------|------|
| 本机 | http://127.0.0.1/ |
| 局域网 | **http://192.168.1.100/** |
| 公网 | **http://你的公网IP/** |
| 域名 | `http://你的域名/` |
| 管理后台 | `http://IP或域名/admin/` |
| API | `http://IP或域名/api/health` |

---

## 8. 日常运维命令

```bash
# API
sudo systemctl status ailunwen-api
sudo systemctl restart ailunwen-api
sudo journalctl -u ailunwen-api -f

# Apache
sudo systemctl status apache2
sudo apache2ctl configtest
sudo systemctl reload apache2
sudo tail -f /var/log/apache2/ailunwen-error.log

# 数据库
sudo systemctl status postgresql
```

---

## 9. 代码更新后怎么重新部署

```bash
cd /home/dell/ailunwen
npm run update:prod
```

等价于：`npm run build` → 重启 API → `reload apache2`。

只改了 `.env` 或后端：

```bash
sudo systemctl restart ailunwen-api
```

---

## 10. 自检清单

```bash
sudo systemctl is-active postgresql
sudo systemctl is-active apache2
sudo systemctl is-active ailunwen-api
curl -s http://127.0.0.1:8787/api/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/
# 局域网浏览器: http://192.168.1.100/
# 公网手机流量: http://你的公网IP/
```

---

## 11. 常见问题

### 打开 80 端口是 Apache 默认页，不是犀材

1. `ls /etc/apache2/sites-enabled/` 确认有 `ailunwen.conf`
2. 检查 `ServerName` / `ServerAlias` 是否匹配你访问用的 IP 或域名
3. `sudo apache2ctl -S` 查看虚拟主机匹配顺序

### `apache2ctl configtest` 失败

```bash
sudo apache2ctl configtest
sudo tail /var/log/apache2/error.log
ls frontend/dist/index.html
```

### 页面能开，登录/检索失败

```bash
sudo systemctl status ailunwen-api
sudo journalctl -u ailunwen-api -n 50 --no-pager
```

### 与 `npm run dev` 冲突

```bash
npm run dev:kill
sudo systemctl restart ailunwen-api
```

**不要同时跑 `npm run dev` 和 `ailunwen-api`。**

### 公网打不开

路由器 `80 → 192.168.1.100:80`、`ufw`、是否有真公网 IP。

---

## 12. HTTPS（可选）

有域名时（Apache + certbot）：

```bash
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d 你的域名.com
sudo ufw allow 443/tcp
```

路由器转发 **443 → 192.168.1.100:443**。

---

## 13. 没有公网 IP 怎么办

| 方案 | 说明 |
|------|------|
| 申请公网 IP | 联系运营商 |
| 内网穿透 | frp、Cloudflare Tunnel 等，指向 `127.0.0.1:80` |
| 云服务器 | 云上部署 + 安全组放行 80 |

---

## 14. 附录：开发模式 `npm run dev`

仅写代码时用，不与生产混跑：

```bash
cd /home/dell/ailunwen
npm run dev
# http://127.0.0.1:5175
```

| 命令 | 用途 |
|------|------|
| `npm run dev` | 本地开发 |
| `npm run install:prod` | **Apache 生产部署（首次）** |
| `npm run update:prod` | 更新后重新部署 |

---

## 部署步骤速记

```bash
# 0. （可选）公网安全：见第 2 节

# 1. 一键部署（Apache，不装 Nginx）
cd /home/dell/ailunwen && npm run install:prod

# 2. 防火墙
sudo ufw allow 80/tcp

# 3. 路由器：外网 80 → 192.168.1.100:80

# 4. 若 IP 访问落到默认页：见第 6 节改 ServerAlias

# 5. 验证
# http://192.168.1.100/
# http://你的公网IP/
```
