# pgAdmin4 配置指南

## 数据库连接信息

根据 `.env` 文件中的配置，您的PostgreSQL数据库信息如下：

| 配置项 | 值 |
|-------|-----|
| **主机** | localhost |
| **端口** | 5432 |
| **数据库名** | material_kb |
| **用户名** | material_user |
| **密码** | material_pass_2024 |

---

## pgAdmin4 连接步骤

### 1. 打开 pgAdmin4
- 启动 pgAdmin4 应用程序
- 在浏览器中访问 `http://localhost:5050`（如果使用桌面版则直接打开）

### 2. 创建服务器连接

1. 在左侧导航栏右键点击 **Servers** → **Register** → **Server...**

2. 在 **General** 标签页：
   - **Name**: `材料AI知识库`（或您喜欢的名称）

3. 在 **Connection** 标签页填写：
   - **Host name/address**: `localhost`
   - **Port**: `5432`
   - **Maintenance database**: `material_kb`
   - **Username**: `material_user`
   - **Password**: `material_pass_2024`
   - ☑️ **Save password**: 勾选保存密码

4. 点击 **Save** 保存连接

### 3. 查看数据库结构

连接成功后，展开服务器节点可以看到：

```
材料AI知识库 (localhost:5432)
├── Databases (1)
│   └── material_kb
│       ├── Schemas (1)
│       │   └── public
│       │       ├── Tables (17)
│       │       │   ├── analysis_results    # 分析结果存储
│       │       │   ├── documents           # 上传文档
│       │       │   ├── keywords            # 关键词
│       │       │   ├── material_categories # 9大材料领域
│       │       │   ├── pdf_index           # PDF文献索引（主表）
│       │       │   ├── papers              # 论文信息
│       │       │   ├── search_cache        # 搜索缓存
│       │       │   ├── search_histories    # 搜索历史
│       │       │   ├── user_memories       # 用户记忆
│       │       │   ├── user_preferences    # 用户偏好
│       │       │   ├── user_topics         # 用户主题
│       │       │   └── users               # 用户表
│       │       └── Views
│       └── ...
└── ...
```

---

## 常用SQL查询

### 查看9大领域数据分布
```sql
SELECT 
    code AS 领域代码,
    name AS 领域名称,
    paper_count AS 论文数量
FROM material_categories
ORDER BY paper_count DESC;
```

### 查看总记录数
```sql
SELECT 
    category AS 类别,
    COUNT(*) AS 记录数
FROM pdf_index
GROUP BY category
ORDER BY COUNT(*) DESC;
```

### 查看最近添加的文献
```sql
SELECT 
    title AS 标题,
    material_name AS 材料名称,
    category AS 类别,
    created_at AS 创建时间
FROM pdf_index
ORDER BY created_at DESC
LIMIT 10;
```

### 搜索特定材料
```sql
SELECT 
    title,
    material_name,
    properties AS 属性,
    applications AS 应用
FROM pdf_index
WHERE material_name ILIKE '%aluminum%'
LIMIT 10;
```

### 查看用户列表
```sql
SELECT 
    username AS 用户名,
    email AS 邮箱,
    created_at AS 注册时间,
    is_active AS 是否活跃
FROM users;
```

### 查看搜索历史统计
```sql
SELECT 
    DATE(created_at) AS 日期,
    COUNT(*) AS 搜索次数
FROM search_histories
GROUP BY DATE(created_at)
ORDER BY 日期 DESC
LIMIT 7;
```

---

## 11个要素字段说明

在 `pdf_index` 表中，11个检索要素对应以下字段：

| 字段名 | 中文名 | 说明 |
|-------|-------|------|
| material_name | 材料名称 | 如：Ti-6Al-4V钛合金 |
| symmetry_phase | 对称相 | 如：六方密堆积(HCP) |
| structure_descriptor | 结构描述符 | 晶体结构描述 |
| properties | 属性 | 力学、物理、化学性能 |
| applications | 应用 | 应用领域 |
| synthesis_method | 合成方法工艺 | 制备工艺 |
| characterization_method | 表征方法 | 测试分析方法 |
| quality_control | 质检 | 质量控制标准 |
| first_author | 第一作者 | 论文第一作者 |
| doi | DOI | 文献DOI编号 |
| corresponding_author | 通讯作者 | 通讯作者 |

---

## 注意事项

1. **确保PostgreSQL服务已启动**
   - 检查Windows服务中 `postgresql-x64-16` 是否正在运行

2. **防火墙设置**
   - 确保端口5432未被防火墙阻止

3. **权限问题**
   - 用户 `material_user` 需要具有对 `material_kb` 数据库的读写权限

4. **连接失败排查**
   - 检查PostgreSQL服务是否运行
   - 检查用户名密码是否正确
   - 检查端口5432是否被占用

---

## 备份数据库

在pgAdmin4中备份数据库：

1. 右键点击 `material_kb` 数据库
2. 选择 **Backup...**
3. 选择备份格式（推荐 **Custom** 或 **Plain**）
4. 选择保存路径
5. 点击 **Backup**

---

**配置完成时间**: 2026-04-24
