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
sudo systemctl restart ailunwen-school-api ailunwen-enterprise-api

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

## 十二、MatSciBERT Python 环境与模型部署

> 本节是**服务器端部署流程**。除从 Windows 使用 FinalShell 上传模型目录外，下面所有 `bash` 命令都必须在 Ubuntu 服务器终端执行，不要在本地 PowerShell 中执行。

本节同时覆盖两个相互独立的 MatSciBERT 功能：

| 功能 | 生产目录 | 入口脚本 |
| --- | --- | --- |
| 检索词实体增强 | `/home/ubuntu/15w` | `backend/scripts/matsci_query_entities.py` |
| PDF 论文元数据抽取 | `/home/ubuntu/MatSciBERT/matscibert-demo` | `backend/scripts/matsci_pdf_meta_extract.py` |

两个模型目录不要移动进代码发布目录。`/home/ubuntu/ailunwen-current` 会在发布时切换，模型和 Python 虚拟环境应放在持久目录中。

### 12.1 安装系统依赖

当前生产服务器为 Ubuntu 24.04。优先使用系统提供的 `python3` 创建独立虚拟环境，不要直接假定默认软件源中存在 `python3.10`。

```bash
sudo apt update
sudo apt install -y \
  python3 \
  python3-venv \
  python3-dev \
  python3-pip \
  build-essential \
  git
```

确认版本：

```bash
python3 --version
```

项目当前的 `requirements-matsci.txt` 使用现代 PyTorch 和 Transformers 4.x（约束为 `transformers>=4.30,<5`）。不要直接混装原始 MatSciBERT 项目的旧版 `transformers==4.6.1`、`tokenizers==0.10.1`，也不要升级到 Transformers 5.x；只有经过单独兼容验证后才能改变主版本，并且必须使用另一个虚拟环境。

### 12.2 创建项目专用 Python 虚拟环境

虚拟环境放在现有项目运行时目录中，与独立 Node 22 并列：

```bash
mkdir -p /home/ubuntu/ailunwen-runtime
python3 -m venv /home/ubuntu/ailunwen-runtime/matsci-venv
```

升级基础打包工具：

```bash
/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python \
  -m pip install --upgrade pip setuptools wheel
```

以后两个 MatSciBERT 功能统一使用：

```text
/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python
```

不要从 Windows 复制 `venv` 到 Linux；虚拟环境必须在服务器本机创建。

### 12.3 安装 PyTorch 和项目依赖

没有确认 NVIDIA 驱动与 CUDA 前，先安装 CPU 版本，最容易验证部署：

```bash
/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python \
  -m pip install torch \
  --index-url https://download.pytorch.org/whl/cpu
```

安装其余依赖：

```bash
cd /home/ubuntu/ailunwen-current

/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python \
  -m pip install -r requirements-matsci.txt
```

确认核心包可以导入：

```bash
/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python -c \
  "import torch, transformers, tokenizers, pandas, nltk, fitz; print('torch:', torch.__version__); print('transformers:', transformers.__version__)"
```

如需 GPU，先运行 `nvidia-smi`，再根据 PyTorch 官方安装选择器所列命令安装与驱动匹配的 CUDA wheel；不要只根据本机安装的 CUDA 工具包版本猜测 wheel 版本。

### 12.4 核对模型文件

检索词实体增强所需文件：

```bash
ls -l \
  /home/ubuntu/15w/pipeline.py \
  /home/ubuntu/15w/vocab_mappings.txt

ls -ld /home/ubuntu/15w/models/MatSciBERT/ner/models/matscholar
```

PDF 元数据抽取所需文件：

```bash
ls -l \
  /home/ubuntu/MatSciBERT/matscibert-demo/ner.py \
  /home/ubuntu/MatSciBERT/matscibert-demo/material_dict.json \
  /home/ubuntu/MatSciBERT/matscibert-demo/model/ner_matscholar/pytorch_model.bin
```

`/home/ubuntu/15w` 中的输出目录、缓存和分类结果不是模型运行的必要文件，可以不纳入备份或发布包。

#### 12.4.1 部署 MatSciBERT 基础模型供离线加载

若服务器不能访问 Hugging Face，需要提前在可联网电脑下载 `m3rg-iitd/matscibert`，并把下列文件上传到 `/home/ubuntu/ailunwen-models/matscibert-base`：

```text
config.json
pytorch_model.bin
special_tokens_map.json
tokenizer.json
tokenizer_config.json
vocab.txt
```

服务器核对：

```bash
ls -lh /home/ubuntu/ailunwen-models/matscibert-base
```

上传自 Windows 的 `/home/ubuntu/15w/pipeline.py` 还需要完成三项兼容处理：

1. 将 `Path(r"E:\\15w")` 改为 `Path(__file__).resolve().parent`；
2. 将 `pipeline.py` 和 `models/MatSciBERT/ner/ner.py` 中的 `m3rg-iitd/matscibert` 改为 `/home/ubuntu/ailunwen-models/matscibert-base`；
3. `pipeline.py` 应优先使用 `from torchcrf import CRF`，不能优先导入 API 不兼容的 `TorchCRF.CRF`。

生产运行使用 `pytorch-crf==0.7.2`，并设置 `HF_HUB_OFFLINE=1` 和 `TRANSFORMERS_OFFLINE=1`，确保服务重启时不依赖外网。

### 12.5 配置生产环境变量

编辑现有生产环境文件，只增加或更新 MatSciBERT 项；禁止覆盖数据库、JWT、短信、微信或大模型密钥：

```bash
sudo nano /home/ubuntu/ailunwen-secrets/ailunwen.env
```

加入：

```env
MATSCI_PYTHON=/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python
MATSCI_META_PYTHON=/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python

MATSCI_PIPELINE_ROOT=/home/ubuntu/15w
MATSCI_NER_DISABLE=0
MATSCI_NER_NO_CRF=0

MATSCI_META_DEMO_DIR=/home/ubuntu/MatSciBERT/matscibert-demo
MATSCI_META_MODEL_DIR=/home/ubuntu/MatSciBERT/matscibert-demo/model/ner_matscholar
PDF_META_ENGINE=ner
MATSCI_META_DEVICE=cuda
MATSCI_META_NORMALIZE=0
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

本服务器的 RTX 4060 Ti 已通过 CUDA 自测，因此使用 `MATSCI_META_DEVICE=cuda`。没有可用 NVIDIA GPU 的服务器应改为：

```env
MATSCI_META_DEVICE=cpu
```

环境文件中同一个变量只能保留一行。修改前可以安全检查 MatSciBERT 项，不要输出整个 `.env`：

```bash
sudo grep -nE '^MATSCI_|^PDF_META_ENGINE=|^HF_HUB_OFFLINE=|^TRANSFORMERS_OFFLINE=' \
  /home/ubuntu/ailunwen-secrets/ailunwen.env
```

### 12.6 分别验证两个模型

验证 PDF 论文元数据抽取：

```bash
MATSCI_META_DEMO_DIR=/home/ubuntu/MatSciBERT/matscibert-demo \
MATSCI_META_MODEL_DIR=/home/ubuntu/MatSciBERT/matscibert-demo/model/ner_matscholar \
MATSCI_META_DEVICE=cuda \
HF_HUB_OFFLINE=1 \
TRANSFORMERS_OFFLINE=1 \
/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python \
  /home/ubuntu/ailunwen-current/backend/scripts/matsci_pdf_meta_extract.py \
  --selftest
```

成功结果应包含：

```json
{"ready": true}
```

验证检索词实体增强：

```bash
MATSCI_PIPELINE_ROOT=/home/ubuntu/15w \
MATSCI_NER_NO_CRF=0 \
HF_HUB_OFFLINE=1 \
TRANSFORMERS_OFFLINE=1 \
/home/ubuntu/ailunwen-runtime/matsci-venv/bin/python \
  /home/ubuntu/ailunwen-current/backend/scripts/matsci_query_entities.py \
  --once '{"text":"Fe3O4 nanoparticles were synthesized by a sol-gel method and used as anodes in lithium-ion batteries."}'
```

成功结果应包含：

```json
{"ok": true, "suffix": "..."}
```

只有两个命令都验证成功后，才能重启生产服务。模型第一次加载可能需要数分钟；CPU 推理明显慢于 GPU 属于正常现象。

### 12.7 依次重启并验证服务

为避免多个进程同时执行数据库结构初始化，依次重启：

```bash
sudo systemctl restart ailunwen-school-api.service
curl -fsS http://127.0.0.1:8787/api/health | python3 -m json.tool

sudo systemctl restart ailunwen-enterprise-api.service
curl -fsS http://127.0.0.1:8788/api/health | python3 -m json.tool

sudo systemctl restart ailunwen-pdf-sync.service
```

健康检查中的 `matsciNerAugment` 应为 `true`。它只表示 Node 服务已识别配置；两个 Python 自测命令通过才表示模型本身真正可用。

检查日志：

```bash
sudo journalctl -u ailunwen-school-api.service -n 100 --no-pager
sudo journalctl -u ailunwen-enterprise-api.service -n 100 --no-pager
sudo journalctl -u ailunwen-pdf-sync.service -n 100 --no-pager
```

常见问题：

- `matsciNerAugment: false`：检查 `MATSCI_PIPELINE_ROOT`、`MATSCI_NER_DISABLE` 和目录权限。
- `ModuleNotFoundError`：确认 systemd 使用的是 `MATSCI_PYTHON` 指定的虚拟环境，而不是系统 `python3`。
- `pipeline.py` 不存在：检索模型根目录应为 `/home/ubuntu/15w`，不是 `matscibert-demo`。
- 报错仍在读取 `E:\\15w\\vocab_mappings.txt`：说明上传的 `15w/pipeline.py` 仍硬编码 Windows 根目录。先备份文件，再把其中的 `Path(r"E:\\15w")` 改为 `Path(__file__).resolve().parent`。
- `CRF.__init__() got an unexpected keyword argument 'num_tags'`：安装 `pytorch-crf==0.7.2`，并把 `pipeline.py` 的 CRF 导入改为优先使用 `from torchcrf import CRF`。
- 尝试连接 `huggingface.co/m3rg-iitd/matscibert`：检查基础模型是否已上传、本地模型路径是否已替换，以及两个离线环境变量是否为 `1`。
- `pytorch_model.bin` 不存在：检查 PDF 模型目录是否上传完整。
- 首次请求长时间等待：先在终端完成两个自测，让模型下载、缓存或加载问题在上线前暴露。
