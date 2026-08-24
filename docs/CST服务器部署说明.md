# CST（犀材探索）服务器部署说明

本文档适用于当前生产服务器部署方式。服务器不能稳定访问 GitHub，因此采用“本地打包、FinalShell 上传、服务器解压”的发布流程。

## 一、当前生产环境

| 项目 | 当前配置 |
| --- | --- |
| 系统用户 | `ubuntu` |
| 后端服务 | `ailunwen-api.service` |
| 后端端口 | `127.0.0.1:8877` |
| 当前代码软链接 | `/home/ubuntu/ailunwen-current` |
| 代码发布目录 | `/home/ubuntu/ailunwen-releases/` |
| 生产环境变量 | `/home/ubuntu/ailunwen-secrets/ailunwen.env` |
| Apache 站点配置 | `/etc/apache2/sites-enabled/syncsee-ailunwen.conf` |
| Apache 前端发布目录 | `/var/www/syncsee-ailunwen/releases/` |
| PostgreSQL 数据库 | `ailunwen_literature_20260805` |
| 生产域名 | `https://syncsee.cstdata.net` |

生产 `.env`、PostgreSQL 数据和 PDF 数据不包含在 Git 代码包中。普通代码更新不得覆盖生产 `.env`，也不得重复导入数据库。

## 二、发布前本地检查

在 Windows PowerShell 中进入项目：

```powershell
cd E:\bot\CST
```

检查改动：

```powershell
git status --short
```

运行测试：

```powershell
npm.cmd test
```

执行生产构建：

```powershell
npm.cmd run build
```

测试及构建均成功后，提交需要发布的代码。不要提交 `.env`、数据库文件、SQL 导出文件或包含密钥的文件。

```powershell
git add 修改的文件
```

```powershell
git commit -m "本次更新说明"
```

```powershell
git push
```

## 三、本地生成发布包

发布包必须通过 `git archive` 生成。该命令只打包已经提交的代码，不会包含 `.env` 和未跟踪的数据库文件。

以下示例使用版本名 `20260820_r6`，每次发布应改成新的日期或版本号。

```powershell
git archive --format=zip --output='E:\bot\CST\CST_20260820_r6.zip' HEAD
```

通过 FinalShell 将文件上传到：

```text
/home/ubuntu/CST_20260820_r6.zip
```

## 四、服务器创建新版本

每个代码框单独执行。

创建新发布目录：

```bash
mkdir -p /home/ubuntu/ailunwen-releases/20260820_r6
```

解压代码：

```bash
unzip -o /home/ubuntu/CST_20260820_r6.zip -d /home/ubuntu/ailunwen-releases/20260820_r6
```

设置服务器 Node.js：

```bash
export PATH=/home/ubuntu/ailunwen-tools/node-v22.23.2-linux-x64/bin:$PATH
```

进入新版本目录：

```bash
cd /home/ubuntu/ailunwen-releases/20260820_r6
```

安装依赖：

```bash
npm ci
```

执行构建：

```bash
npm run build
```

`npm audit` 的漏洞提示不代表构建失败。不要直接执行 `npm audit fix --force`。只有出现构建错误时才停止发布。

检查前端产物：

```bash
ls -lh /home/ubuntu/ailunwen-releases/20260820_r6/dist/index.html
```

## 五、切换后端版本

构建成功后，将当前版本软链接切换到新版本：

```bash
sudo ln -sfnT /home/ubuntu/ailunwen-releases/20260820_r6 /home/ubuntu/ailunwen-current
```

确认软链接：

```bash
readlink -f /home/ubuntu/ailunwen-current
```

重启后端：

```bash
sudo systemctl restart ailunwen-api.service
```

检查服务：

```bash
sudo systemctl status ailunwen-api.service --no-pager
```

检查健康接口（生产端口为 `8877`）：

```bash
curl -fsS http://127.0.0.1:8877/api/health
```

正常响应应包含：

```json
{"ok":true,"service":"quantum-pinnacle"}
```

出现异常时查看日志：

```bash
sudo journalctl -u ailunwen-api.service -n 120 --no-pager
```

## 六、发布前端到 Apache

后端软链接切换不会自动更新 Apache 的静态目录，必须单独发布前端。

创建前端发布目录：

```bash
sudo mkdir -p /var/www/syncsee-ailunwen/releases/frontend-20260820_r6
```

复制构建产物：

```bash
sudo cp -a /home/ubuntu/ailunwen-current/dist/. /var/www/syncsee-ailunwen/releases/frontend-20260820_r6/
```

备份 Apache 配置：

```bash
sudo cp /etc/apache2/sites-enabled/syncsee-ailunwen.conf /etc/apache2/sites-enabled/syncsee-ailunwen.conf.before_20260820_r6
```

编辑配置：

```bash
sudo nano /etc/apache2/sites-enabled/syncsee-ailunwen.conf
```

将 HTTP 和 HTTPS 两个虚拟主机中的以下两类路径改成新目录：

```apache
DocumentRoot /var/www/syncsee-ailunwen/releases/frontend-20260820_r6

<Directory /var/www/syncsee-ailunwen/releases/frontend-20260820_r6>
```

保存后检查配置：

```bash
sudo apache2ctl configtest
```

只有显示 `Syntax OK` 才能重新加载：

```bash
sudo systemctl reload apache2
```

检查线上静态资源版本：

```bash
curl -ks https://syncsee.cstdata.net/ | grep -oE 'assets/index-[^"]+\.js'
```

浏览器使用 `Ctrl+F5` 强制刷新。

## 七、只修改后端时的快速发布

如果只修改了后端单个文件，不涉及前端和依赖，可以使用热修复方式，不必执行 `npm ci`、前端构建或 Apache 更新。

本地压缩修改文件，例如：

```powershell
Compress-Archive -LiteralPath 'E:\bot\CST\backend\db.js' -DestinationPath 'E:\bot\CST\backend-hotfix.zip' -Force
```

上传到服务器 `/home/ubuntu/backend-hotfix.zip`，然后备份当前文件：

```bash
sudo cp /home/ubuntu/ailunwen-current/backend/db.js /home/ubuntu/ailunwen-current/backend/db.js.before_hotfix
```

解压：

```bash
sudo unzip -o /home/ubuntu/backend-hotfix.zip -d /tmp/backend-hotfix
```

覆盖文件：

```bash
sudo cp /tmp/backend-hotfix/db.js /home/ubuntu/ailunwen-current/backend/db.js
```

重启并检查：

```bash
sudo systemctl restart ailunwen-api.service
```

```bash
curl -fsS http://127.0.0.1:8877/api/health
```

热修复完成后，必须把相同修改提交到 Git，避免下一次完整部署时丢失。

## 八、修改模型配置

生产模型配置位于：

```text
/home/ubuntu/ailunwen-secrets/ailunwen.env
```

编辑：

```bash
sudo nano /home/ubuntu/ailunwen-secrets/ailunwen.env
```

本地 `.env` 只复制以下模型配置，不能整份覆盖生产 `.env`：

```env
LLM_PROVIDER_A_API_KEY=...
LLM_PROVIDER_A_BASE_URL=...
LLM_PROVIDER_A_MODEL=...
LLM_PROVIDER_B_API_KEY=...
LLM_PROVIDER_B_BASE_URL=...
LLM_PROVIDER_B_MODEL=...
LLM_PROVIDER_C_API_KEY=...
LLM_PROVIDER_C_BASE_URL=...
LLM_PROVIDER_C_MODEL=...
WEB_TRI_MODE=...
WEB_TRI_CONCURRENCY=...
```

必须保留服务器现有的 `NODE_ENV`、`PORT`、`DATABASE_URL`、`JWT_SECRET` 和 `ADMIN_USERNAMES`。

修改后只需重启后端，不需要重新构建：

```bash
sudo systemctl restart ailunwen-api.service
```

禁止把包含 API Key、数据库密码或 JWT 密钥的截图发送给他人。密钥一旦暴露，应立即轮换。

### 微信网站应用扫码登录配置

微信登录与微信支付是两套独立配置。确认微信开放平台「网站应用」已审核通过，并将授权回调域设置为：

```text
syncsee.cstdata.net
```

在 `/home/ubuntu/ailunwen-secrets/ailunwen.env` 中增加：

```env
WECHAT_OPEN_APP_ID=wx...
WECHAT_OPEN_APP_SECRET=...
WECHAT_OPEN_REDIRECT_URI=https://syncsee.cstdata.net/api/v1/auth/wechat/callback
WECHAT_OPEN_FRONTEND_URL=https://syncsee.cstdata.net/
```

`WECHAT_OPEN_APP_SECRET` 只能保存在服务器私密环境文件中，禁止写入前端、Git 或聊天截图。修改后重启 API：

```bash
sudo systemctl restart ailunwen-api.service
```

检查功能开关，返回值中的 `wechatLogin` 应为 `true`：

```bash
curl -fsS http://127.0.0.1:8877/api/health
```

## 九、数据库操作注意事项

普通代码发布不得覆盖或重新导入数据库。数据库变化前必须先备份：

```bash
mkdir -p /home/ubuntu/backups
```

```bash
sudo -u postgres pg_dump -Fc ailunwen_literature_20260805 > /home/ubuntu/backups/ailunwen_before_change.dump
```

当前 PDF 数据位于 PostgreSQL 的 `paper_pdf_files` 表。可以使用以下命令检查：

```bash
sudo -u postgres psql -d ailunwen_literature_20260805 -c "SELECT count(*) AS pdf_count, pg_size_pretty(sum(octet_length(pdf_data))) AS pdf_size FROM paper_pdf_files;"
```

数据库迁移文件必须先验证编码和哈希。不要通过 FinalShell 直接上传大型裸 SQL 文本；应压缩为 ZIP 后上传，再在服务器解压。

## 十、回滚

### 后端回滚

将软链接切回上一个正常版本，例如：

```bash
sudo ln -sfnT /home/ubuntu/ailunwen-releases/20260819_8111bee_upload_r5 /home/ubuntu/ailunwen-current
```

```bash
sudo systemctl restart ailunwen-api.service
```

### 前端回滚

编辑 Apache 配置，将 `DocumentRoot` 和 `<Directory>` 改回上一个前端发布目录，然后执行：

```bash
sudo apache2ctl configtest
```

```bash
sudo systemctl reload apache2
```

### 验证回滚

```bash
curl -fsS http://127.0.0.1:8877/api/health
```

```bash
curl -ks https://syncsee.cstdata.net/ | grep -oE 'assets/index-[^"]+\.js'
```

## 十一、发布检查清单

- 本地测试通过。
- 本地生产构建通过。
- 代码已提交，发布包由 `git archive HEAD` 生成。
- 新版本解压到独立目录，没有覆盖旧版本。
- `/home/ubuntu/ailunwen-current` 已指向新版本。
- `ailunwen-api.service` 为 `active (running)`。
- `http://127.0.0.1:8877/api/health` 返回正常。
- Apache 已切换到新前端目录并显示 `Syntax OK`。
- 浏览器强制刷新后页面版本正确。
- 数据库、PDF、积分和模型回答均完成验证。
