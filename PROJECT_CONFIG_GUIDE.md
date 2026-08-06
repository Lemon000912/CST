# 项目配置完整指南

- **前端**：`frontend/`（Vite + React，`npm run dev:client` / `npm run build`）
- **后端**：`backend/`（Node API，`npm run dev:server`）

## 📦 项目信息

- **项目名称**: paper-query (AI材料科学文献查询系统)
- **当前版本**: 1.0.0
- **数据库**: PostgreSQL 16
- **数据规模**: 
  - DOI记录: 272万条
  - 8大类文献: 385万条
  - 总计: 657万条文献数据

---

## 🗄️ PostgreSQL 数据库配置

### 1. 安装信息

| 项目 | 详情 |
|------|------|
| **安装路径** | `D:\postgresql` |
| **数据目录** | `D:\postgresql\data` |
| **版本** | PostgreSQL 16 |
| **服务名** | postgresql-x64-16 |

### 2. 连接配置 (.env)

```env
# PostgreSQL 数据库配置
DB_HOST=localhost
DB_PORT=5432
DB_NAME=material_kb
DB_USER=postgres
DB_PASSWORD=123456
```

### 3. 数据库结构

```
material_kb (数据库)
├── 表 (Tables)
│   ├── doi_records              # 272万条DOI数据
│   ├── chemistry_catalyst       # 化学与催化 (64万条)
│   ├── materials_science        # 材料科学与工程 (77万条)
│   ├── physics_optics           # 物理与光学 (47万条)
│   ├── nano_materials           # 纳米科技与纳米材料 (17万条)
│   ├── top_journals             # 综合顶级期刊 (44万条)
│   ├── energy_electrochem       # 能源与电化学 (38万条)
│   ├── computational_theory     # 计算与理论 (37万条)
│   ├── metals_alloys            # 金属与合金 (36万条)
│   ├── ceramics_inorganic       # 陶瓷与无机非金属材料 (25万条)
│   ├── pdf_index                # PDF索引
│   ├── aizhishi_papers          # 原始文献表
│   └── ... 其他系统表
│
└── 索引 (Indexes)
    ├── idx_doi_records_doi
    ├── idx_doi_records_year
    ├── idx_doi_records_journal
    └── ... 各表索引
```

### 4. 常用命令

```bash
# 启动服务
net start postgresql-x64-16

# 停止服务
net stop postgresql-x64-16

# 连接数据库
psql -h localhost -U postgres -d material_kb

# 备份数据库
pg_dump -h localhost -U postgres -d material_kb > material_kb_backup.sql

# 恢复数据库
psql -h localhost -U postgres -d material_kb < material_kb_backup.sql
```

---

## 🎨 pgAdmin 4 配置

### 1. 安装信息

| 项目 | 详情 |
|------|------|
| **配置目录** | `C:\Users\User\AppData\Roaming\pgAdmin` |
| **数据库文件** | `C:\Users\User\AppData\Roaming\pgAdmin\pgadmin4.db` |
| **会话文件** | `C:\Users\User\AppData\Roaming\pgAdmin\sessions\` |
| **存储文件** | `C:\Users\User\AppData\Roaming\pgAdmin\storage\` |

### 2. 服务器连接配置

```
服务器名称: PostgreSQL 16
主机: localhost
端口: 5432
维护数据库: postgres
用户名: postgres
密码: 123456
```

### 3. 快速连接步骤

1. 打开 pgAdmin 4
2. 点击 **Servers** → **Register** → **Server**
3. 填写连接信息:
   - **General** 标签: 名称 = `PostgreSQL 16`
   - **Connection** 标签:
     - Host: `localhost`
     - Port: `5432`
     - Database: `material_kb`
     - Username: `postgres`
     - Password: `123456`
4. 点击 **Save**

---

## 🚀 新项目配置步骤

### 步骤 1: 复制项目文件

```bash
# 复制整个项目目录到新位置
cp -r e:\aicai e:\new_project

# 或压缩后复制
zip -r project.zip e:\aicai
```

### 步骤 2: 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件
DB_HOST=localhost
DB_PORT=5432
DB_NAME=material_kb      # 或使用新数据库名
DB_USER=postgres
DB_PASSWORD=123456
```

### 步骤 3: 安装依赖

```bash
npm install
```

### 步骤 4: 配置数据库

```bash
# 方法1: 使用现有数据库
# 直接运行项目，会自动连接 material_kb

# 方法2: 创建新数据库
node backend/scripts/createNewDatabase.js

# 方法3: 导入数据到新数据库
node backend/scripts/importDoiCopy.js
node backend/scripts/importCategories.js
```

### 步骤 5: 启动项目

```bash
npm run dev
```

---

## 📁 关键文件清单

### 配置文件

| 文件 | 说明 |
|------|------|
| `.env` | 环境变量配置 |
| `backend/config/database.js` | 数据库连接配置 |
| `backend/config/initDatabase.js` | 数据库初始化 |
| `backend/db.js` | 数据库操作封装 |

### 数据文件

| 文件 | 说明 | 大小 |
|------|------|------|
| `E:\mysql\output_final\doi\doi.csv` | DOI数据 | 1.55 GB |
| `E:\mysql\output_final\化学与催化_汇总.csv` | 化学与催化文献 | 243 MB |
| `E:\mysql\output_final\材料科学与工程_汇总.csv` | 材料科学与工程文献 | 353 MB |
| `E:\mysql\output_final\物理与光学_汇总.csv` | 物理与光学文献 | 192 MB |
| `E:\mysql\output_final\纳米科技与纳米材料_汇总.csv` | 纳米科技文献 | 91 MB |
| `E:\mysql\output_final\综合顶级期刊_汇总.csv` | 顶级期刊文献 | 140 MB |
| `E:\mysql\output_final\能源与电化学_汇总.csv` | 能源与电化学文献 | 145 MB |
| `E:\mysql\output_final\计算与理论_汇总.csv` | 计算与理论文献 | 127 MB |
| `E:\mysql\output_final\金属与合金_汇总.csv` | 金属与合金文献 | 175 MB |
| `E:\mysql\output_final\陶瓷与无机非金属材料_汇总.csv` | 陶瓷文献 | 89 MB |

### 导入脚本

| 文件 | 说明 |
|------|------|
| `backend/scripts/importDoiCopy.js` | 导入DOI数据 |
| `backend/scripts/importCategories.js` | 导入8大类文献 |
| `backend/scripts/importDoiStream.js` | 流式导入DOI |
| `backend/scripts/importDoiSimple.js` | 简单导入DOI |

---

## 🔧 故障排除

### 连接失败

```bash
# 检查服务状态
net start | findstr postgresql

# 启动服务
net start postgresql-x64-16

# 检查端口
netstat -ano | findstr 5432
```

### 权限问题

```sql
-- 在 psql 中执行
GRANT ALL PRIVILEGES ON DATABASE material_kb TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO postgres;
```

### 数据导入问题

```bash
# 检查文件编码
file -i E:\mysql\output_final\doi\doi.csv

# 转换编码
iconv -f UTF-8 -t UTF-8 E:\mysql\output_final\doi\doi.csv > doi_utf8.csv
```

---

## 📊 数据库统计

```sql
-- 查看所有表记录数
SELECT 
  schemaname,
  tablename,
  n_tup_ins - n_tup_del as row_count
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY row_count DESC;

-- 查看数据库大小
SELECT pg_size_pretty(pg_database_size('material_kb'));

-- 查看表大小
SELECT 
  tablename,
  pg_size_pretty(pg_total_relation_size(tablename::regclass)) as size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(tablename::regclass) DESC;
```

---

## 📞 技术支持

- **PostgreSQL文档**: https://www.postgresql.org/docs/16/
- **pgAdmin文档**: https://www.pgadmin.org/docs/
- **Node.js pg模块**: https://node-postgres.com/

---

*最后更新: 2026-04-27*
