# 材料AI知识库系统

基于流程图设计的智能材料知识库系统，支持材料检索、论文分析和智能推荐。

## 📋 系统架构

根据流程图设计，系统包含以下核心模块：

### 核心流程
1. **用户系统** - 登录注册、用户ID管理、记忆功能
2. **查询处理** - 大模型理解查询并重写检索词
3. **数据检索** - 支持网页检索和数据库检索
4. **数据处理** - 论文排序、去重、可行度评估
5. **AI融合** - 使用CE+GStack融合数据
6. **文档获取** - DOI→SciHub→下载文档
7. **缓存系统** - Redis缓存机制
8. **推荐系统** - 基于用户特征的推荐决策

## 🛠️ 技术栈

- **后端**: Python 3.14 + FastAPI
- **数据库**: PostgreSQL + Redis
- **AI模型**: OpenAI/Claude API
- **向量数据库**: ChromaDB/Qdrant
- **文档处理**: PyMuPDF, python-docx

## 📁 项目结构

```
.
├── app/                    # 应用主模块
│   └── main.py            # FastAPI应用入口
├── api/                    # API路由
│   ├── routes.py          # 路由汇总
│   └── endpoints/         # 各模块接口
│       ├── auth.py        # 认证接口
│       ├── search.py      # 搜索接口
│       ├── documents.py   # 文档接口
│       ├── users.py       # 用户接口
│       ├── recommend.py   # 推荐接口
│       └── analysis.py    # 分析接口
├── core/                   # 核心配置
│   └── config.py          # 配置管理
├── models/                 # 数据模型
│   └── database.py        # SQLAlchemy模型
├── services/               # 业务服务
│   ├── llm_service.py     # LLM服务
│   ├── search_service.py  # 搜索服务
│   ├── memory_service.py  # 记忆服务
│   ├── recommend_service.py # 推荐服务
│   └── fusion_service.py  # 数据融合服务
├── utils/                  # 工具函数
│   └── helpers.py         # 辅助函数
├── data/                   # 数据存储
├── logs/                   # 日志文件
├── tests/                  # 测试文件
├── requirements.txt        # Python依赖
├── .env.example           # 环境变量示例
└── README.md              # 项目说明
```

## 🚀 快速开始

### 1. 环境准备

确保已安装：
- Python 3.14+
- PostgreSQL 14+
- Redis 7+

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填写必要的配置
```

### 4. 启动服务

```bash
# 开发模式
python app/main.py

# 或使用uvicorn
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 5. 访问API文档

启动后访问：http://localhost:8000/docs

## 📚 API接口

### 认证接口
- `POST /api/v1/auth/login` - 用户登录
- `POST /api/v1/auth/register` - 用户注册
- `POST /api/v1/auth/refresh` - 刷新令牌

### 搜索接口
- `POST /api/v1/search/` - 执行搜索
- `GET /api/v1/search/suggest` - 搜索建议
- `POST /api/v1/search/rewrite` - 查询重写

### 文档接口
- `POST /api/v1/documents/upload` - 上传文档
- `GET /api/v1/documents/` - 文档列表
- `POST /api/v1/documents/{id}/analyze` - 分析文档

### 用户接口
- `GET /api/v1/users/profile` - 用户资料
- `GET /api/v1/users/memory` - 用户记忆
- `POST /api/v1/users/memory/save` - 保存记忆

### 推荐接口
- `POST /api/v1/recommend/` - 获取推荐
- `GET /api/v1/recommend/check` - 检查推荐

### 分析接口
- `POST /api/v1/analysis/fuse` - 数据融合
- `POST /api/v1/analysis/content` - 内容分析

## 🔧 配置说明

### 必需配置
- `DATABASE_URL` - PostgreSQL连接字符串
- `REDIS_URL` - Redis连接字符串
- `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY` - LLM API密钥

### 可选配置
- `CHROMA_PERSIST_PATH` - 向量数据库存储路径
- `DOCUMENT_STORAGE_PATH` - 文档存储路径
- `LOG_LEVEL` - 日志级别

## 📝 开发计划

- [ ] 完善数据库模型和迁移
- [ ] 实现用户认证系统
- [ ] 集成学术搜索API
- [ ] 实现文档解析和处理
- [ ] 集成LLM服务
- [ ] 实现推荐算法
- [ ] 前端界面开发
- [ ] 部署和运维

## 📄 许可证

MIT License
