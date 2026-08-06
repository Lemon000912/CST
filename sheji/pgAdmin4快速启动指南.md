# pgAdmin4 快速启动和可视化指南

## 🚀 快速启动pgAdmin4

### 方法一：通过Windows开始菜单
1. 点击Windows开始按钮
2. 搜索 "pgAdmin 4"
3. 点击打开

### 方法二：通过浏览器访问
1. 打开浏览器
2. 访问 `http://localhost:5050` 或 `http://127.0.0.1:5050`
3. 输入pgAdmin4的登录密码（安装时设置的）

---

## 🔌 连接到材料AI知识库数据库

### 步骤1：注册新服务器

1. 在左侧导航栏，右键点击 **Servers**
2. 选择 **Register** → **Server...**

```
Servers (右键)
  └── Register
        └── Server...
```

### 步骤2：填写连接信息

#### General 标签页：
```
Name: 材料AI知识库
```

#### Connection 标签页：
```
Host name/address: localhost
Port: 5432
Maintenance database: material_kb
Username: material_user
Password: material_pass_2024
☑️ Save password: [勾选]
```

### 步骤3：保存连接
点击 **Save** 按钮

---

## 📊 可视化查看数据库结构

### 查看数据库树形结构

连接成功后，展开服务器节点：

```
材料AI知识库 (localhost:5432)
├── Databases (1)
│   └── material_kb
│       ├── Casts
│       ├── Catalogs
│       ├── Event Triggers
│       ├── Extensions
│       ├── Foreign Data Wrappers
│       ├── Languages
│       ├── Publications
│       ├── Schemas (1)
│       │   └── public
│       │       ├── Collations
│       │       ├── Domains
│       │       ├── FTS Configurations
│       │       ├── FTS Dictionaries
│       │       ├── FTS Parsers
│       │       ├── FTS Templates
│       │       ├── Functions
│       │       ├── Materialized Views
│       │       ├── Operators
│       │       ├── Sequences
│       │       ├── Tables (17)              ← 【点击这里查看所有表】
│       │       │   ├── analysis_results    # 分析结果存储
│       │       │   ├── documents           # 上传文档
│       │       │   ├── keywords            # 关键词
│       │       │   ├── material_categories # 9大材料领域
│       │       │   ├── pdf_index           # PDF文献索引（主表，27,312条）
│       │       │   ├── papers              # 论文信息
│       │       │   ├── search_cache        # 搜索缓存
│       │       │   ├── search_histories    # 搜索历史
│       │       │   ├── user_memories       # 用户记忆
│       │       │   ├── user_preferences    # 用户偏好
│       │       │   ├── user_topics         # 用户主题
│       │       │   └── users               # 用户表
│       │       ├── Trigger Functions
│       │       ├── Types
│       │       └── Views
│       └── Tablespaces
└── ...
```

---

## 🔍 使用Query Tool查看数据

### 打开Query Tool

1. 在左侧导航栏，点击 **material_kb** 数据库
2. 点击顶部菜单 **Tools** → **Query Tool**
3. 或者按 `Alt+Shift+Q`

### 运行可视化查询

#### 1. 查看9大领域分布（带可视化）
```sql
SELECT 
    name AS 领域名称,
    paper_count AS 文献数量,
    ROUND(paper_count::numeric / (SELECT COUNT(*) FROM pdf_index) * 100, 2) AS 占比百分比,
    CASE 
        WHEN paper_count > 10000 THEN '██████████ 非常丰富'
        WHEN paper_count > 5000 THEN '███████░░░ 丰富'
        WHEN paper_count > 1000 THEN '████░░░░░░ 中等'
        ELSE '██░░░░░░░░ 较少'
    END AS 可视化
FROM material_categories
ORDER BY paper_count DESC;
```

#### 2. 查看11个要素数据完整性
```sql
SELECT 
    '材料名称' AS 要素,
    COUNT(*) FILTER (WHERE material_name IS NOT NULL) AS 填充数,
    COUNT(*) AS 总数,
    ROUND(COUNT(*) FILTER (WHERE material_name IS NOT NULL)::numeric / COUNT(*) * 100, 1) || '%' AS 完整度
FROM pdf_index
UNION ALL
SELECT '第一作者', COUNT(*) FILTER (WHERE first_author IS NOT NULL), COUNT(*), ROUND(COUNT(*) FILTER (WHERE first_author IS NOT NULL)::numeric / COUNT(*) * 100, 1) || '%' FROM pdf_index
UNION ALL
SELECT 'DOI', COUNT(*) FILTER (WHERE doi IS NOT NULL), COUNT(*), ROUND(COUNT(*) FILTER (WHERE doi IS NOT NULL)::numeric / COUNT(*) * 100, 1) || '%' FROM pdf_index
UNION ALL
SELECT '属性', COUNT(*) FILTER (WHERE properties IS NOT NULL), COUNT(*), ROUND(COUNT(*) FILTER (WHERE properties IS NOT NULL)::numeric / COUNT(*) * 100, 1) || '%' FROM pdf_index
ORDER BY 完整度 DESC;
```

#### 3. 查看热门材料TOP 20
```sql
SELECT 
    ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS 排名,
    material_name AS 材料名称,
    COUNT(*) AS 文献数量,
    category AS 所属类别
FROM pdf_index
WHERE material_name IS NOT NULL
GROUP BY material_name, category
ORDER BY 文献数量 DESC
LIMIT 20;
```

#### 4. 查看数据库统计仪表盘
```sql
-- 数据库整体统计
SELECT 
    '总文献数' AS 指标,
    COUNT(*)::text AS 数值
FROM pdf_index
UNION ALL
SELECT '总用户数', COUNT(*)::text FROM users
UNION ALL
SELECT '材料类别数', COUNT(*)::text FROM material_categories
UNION ALL
SELECT '搜索历史数', COUNT(*)::text FROM search_histories
UNION ALL
SELECT '分析结果数', COUNT(*)::text FROM analysis_results;
```

---

## 📈 使用pgAdmin4的图形化功能

### 1. 查看表的ER图（实体关系图）

1. 展开 **Schemas** → **public** → **Tables**
2. 按住 `Ctrl` 键，选择多个表（如：users, pdf_index, material_categories）
3. 右键点击选中的表
4. 选择 **ERD For Selection**（实体关系图）

### 2. 查看表的数据分布图表

1. 右键点击 **pdf_index** 表
2. 选择 **View/Edit Data** → **All Rows**
3. 在结果窗口中，点击 **Graph Visualizer** 图标
4. 选择要可视化的列（如：category）

### 3. 导出数据为CSV/Excel

1. 在Query Tool中运行查询
2. 点击结果窗口的 **Download as CSV** 按钮（💾图标）
3. 选择保存位置

---

## 🎨 自定义界面

### 更改主题
1. 点击 **File** → **Preferences**
2. 选择 **Miscellaneous** → **Themes**
3. 选择 **Dark** 或 **Standard** 主题

### 调整字体大小
1. **File** → **Preferences**
2. **Query Tool** → **Results Grid**
3. 调整 **Font size**

---

## 💡 常用快捷键

| 快捷键 | 功能 |
|--------|------|
| `F5` | 执行查询 |
| `Alt+Shift+Q` | 打开Query Tool |
| `Ctrl+/` | 注释/取消注释 |
| `Ctrl+E` | 解释查询计划 |
| `Ctrl+G` | 跳转到行 |

---

## 📞 故障排除

### 连接失败
1. 检查PostgreSQL服务是否运行：
   - Windows服务中查找 `postgresql-x64-18`
   - 确保状态为"正在运行"

2. 检查防火墙设置：
   - 确保端口5432未被阻止

3. 检查用户名密码：
   - 用户名：`material_user`
   - 密码：`material_pass_2024`

### 查询超时
1. 在Query Tool中，点击 **Query** → **Execute Options**
2. 增加 **Query