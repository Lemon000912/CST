# 服务器 PDF 库与 PostgreSQL 部署

不需要、也不能把 Windows 的 `D:\postgresql\data` 数据目录直接复制到 Ubuntu。Windows 与 Linux 的 PostgreSQL 数据目录不是跨系统迁移格式。

## 部署顺序

1. 在 Ubuntu 安装 PostgreSQL，创建生产数据库和专用用户，数据库端口不要暴露到公网。
2. 如果需要保留本地已有数据，在 Windows 使用 `pg_dump` 生成逻辑备份，在 Ubuntu 使用 `pg_restore` 导入。只迁移需要的业务表也可以。
3. 在服务器项目根目录的 `.env` 配置：

   ```env
   DATABASE_URL=postgresql://生产用户:强密码@127.0.0.1:5432/material_kb
   LOCAL_PDF_IMPORT_ROOT=/home/ubuntu/papers
   ```

4. 确保运行服务的 Ubuntu 用户对 `/home/ubuntu/papers` 和十个分类目录有读取权限。
5. 执行 `npm run install:prod`。安装脚本会同时启动 API 和 `ailunwen-pdf-sync` 增量同步服务。

## 同步行为

- 每 60 秒扫描一次十个分类目录，包括“其他类”。
- 不限制每类文件数量，也不因 3 MB、20 MB 或更大的文件而排除。
- 新文件稳定 30 秒后，先校验 PDF、流式计算 SHA-256，然后立即把路径和元数据登记到 PostgreSQL；下载时直接从服务器文件系统流式发送。
- 正文提取在独立的受限子进程中后台执行。默认每轮处理 2 个，单文件超时 120 秒、内存上限 384 MB、最多尝试 3 次。解析失败不影响文件下载。
- PostgreSQL 不保存新 PDF 的原始二进制，只保存相对路径、大小、修改时间、SHA-256、分类和解析状态。旧版已经保存在 `BYTEA` 中的 PDF 仍兼容下载。

可在服务器 `.env` 或 systemd 命令中调整扫描参数；常用手工检查命令：

```bash
npm run pdf:sync
sudo systemctl status ailunwen-pdf-sync
sudo journalctl -u ailunwen-pdf-sync -f
```

首次部署前可先验证 PostgreSQL：

```bash
psql "$DATABASE_URL" -c "select current_database(), current_user;"
```
