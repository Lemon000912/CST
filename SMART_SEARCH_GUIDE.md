# 智能联网搜索功能使用指南

## 🎯 功能说明

当前项目采用“先检索、后综合”的联网流程：请求发送后由后端调用已配置的多路搜索源，模型只负责基于检索摘录生成回答。

### 与原有搜索的区别

| 特性 | 原有搜索 (`/api/v1/search`) | 智能搜索 (`/api/v1/search/smart`) |
|------|---------------------------|----------------------------------|
| 搜索触发 | 请求发送后自动执行 | 请求发送后自动执行 |
| 搜索来源 | `WEB_SOURCES` 与定向行业源 | 同左 |
| 搜索策略 | 多源并行、去重、相关性筛选 | 同左 |
| 模型职责 | 基于检索结果综合回答 | 同左 |

## 🚀 快速开始

### 1. 配置检查

确保 `.env` 文件中已配置：

```bash
# LLM Provider（用于检索结果综合）
LLM_PROVIDER_A_API_KEY=your_api_key
LLM_PROVIDER_A_BASE_URL=https://api.openai.com/v1/chat/completions
LLM_PROVIDER_A_MODEL=gpt-4  # 或 deepseek-chat, qwen-max 等

# 搜索API（至少配置一个）
BRAVE_API_KEY=your_brave_api_key
# 或
TAVILY_API_KEY=your_tavily_api_key
# 或
DATAIFY_API_KEY=your_dataify_api_key
```

### 2. 启动服务

```bash
npm start
```

看到以下输出表示成功：
```
[Smart Search] 智能搜索API: POST /api/v1/search/smart
```

### 3. 调用API

```bash
curl -X POST http://127.0.0.1:3000/api/v1/search/smart \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "query": "2026年MTBE、苯乙烯、环氧丙烷的产能利用率",
    "forceWebSearch": true
  }'
```

## 📋 API参数说明

### 请求参数

```javascript
{
  "query": "用户问题",           // 必需，用户查询
  "forceWebSearch": false,       // 兼容旧参数，当前不会触发 web_search 工具
  "includeDatabase": true,       // 可选，是否包含数据库检索（默认true）
  "model": "gpt-4"              // 可选，指定模型
}
```

### 响应格式

```javascript
{
  "query": "用户问题",
  "answer": "模型生成的完整答案",
  "papers": [...],              // 数据库检索的结果
  "toolCalls": [],               // 当前固定为空；联网检索已在前置阶段完成
  "usage": {                    // Token使用情况
    "inputTokens": 1234,
    "outputTokens": 567
  },
  "provider": "gpt-4",
  "timestamp": "2026-10-13T..."
}
```

## 🔍 工作原理

### 流程图

```
用户提问
    ↓
判断是否需要联网搜索
    ↓
├─ 需要 → 调用LLM（带工具定义）
│         ↓
│     模型决定调用 web_search
│         ↓
│     执行联网搜索
│         ↓
│     将搜索结果返回给模型
│         ↓
│     模型可以继续搜索或生成答案
│         ↓
│     最多3轮工具调用
│
└─ 不需要 → 直接基于现有信息回答
    ↓
返回最终答案
```

### 自动触发条件

模型会在以下情况下自动触发联网搜索：

1. ✅ 查询包含**年份**（如2026、2025）
2. ✅ 包含**实时性关键词**（最新、当前、现在、今年）
3. ✅ 包含**数据指标**（产能利用率、价格、开工率、销量）
4. ✅ 现有信息不足（<5条结果）

**满足其中2个条件即自动启用工具。**

## 📊 测试示例

### 示例1：多实体产能利用率查询

**问题**：
```
2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率
```

**预期行为**：
- 模型识别出14个实体 + 2026年 + 产能利用率指标
- 自动触发联网搜索
- 模型规划多条查询：
  - `MTBE 产能利用率 2026年`
  - `隆众资讯 化工品 产能利用率 2026`
  - `苯乙烯 开工率 2026年`
  - ...（可能2-3轮搜索）
- 基于搜索结果综合回答

### 示例2：最新价格查询

**问题**：
```
查询2026年10月铜的最新价格
```

**预期行为**：
- 模型识别出"最新"关键词 + 2026年
- 触发联网搜索：`铜价格 2026年10月`
- 返回实时价格信息

### 示例3：一般性问题（不触发）

**问题**：
```
什么是人工智能？
```

**预期行为**：
- 无时间、无指标、非实时查询
- 不触发联网搜索
- 基于模型知识直接回答

## 🧪 运行测试

```bash
# 运行测试脚本
node backend/test/smartSearch.test.js
```

测试脚本会执行3个测试用例，展示不同场景下的行为。

## 🔧 调试日志

启动服务后，查看日志：

```bash
# 搜索请求日志
[api.search.smart] query="..." force=true

# 工具调用日志
[llm.tools] Enabled web_search tool, max iterations: 3
[llm.tools] Iteration 1/3
[llm.tools] Processing 1 tool call(s)
[llm.tools] Executing tool: web_search
[tool.web_search] query="MTBE 产能利用率 2026" max=10 type=general
[tool.web_search] Found 8 results for "MTBE 产能利用率 2026"
[llm.tools] Tool executed successfully, result length: 1234
[llm.tools] Completed with 2 total tool calls
```

## ⚙️ 配置调优

### 修改最大工具调用次数

在 `backend/llmClientWithTools.js` 中：

```javascript
const MAX_TOOL_ITERATIONS = 3; // 修改为 5 可以允许更多轮搜索
```

### 修改触发条件

在 `backend/synthesizeWithTools.js` 的 `shouldEnableWebSearchTool` 函数中调整逻辑。

### 支持的模型

✅ **已测试支持**：
- OpenAI GPT-4, GPT-3.5
- Deepseek Chat
- Qwen Max/Plus
- 其他OpenAI兼容API

❌ **暂不支持**：
- Google Gemini（需要特殊适配）

## 🐛 常见问题

### Q: 为什么没有 web_search 工具调用日志？

这是预期行为。当前流程不把 `web_search` Function Calling 工具提供给模型；请查看 `sourcesUsed`、`/api/v1/mcp/status` 和各网页源日志确认前置检索状态。

### Q: 搜索失败？

**排查步骤**：
1. 检查搜索API Key是否配置正确
2. 查看 `[tool.web_search]` 日志
3. 确认网络连接正常
4. 检查API配额是否用完

### Q: 响应太慢？

**优化方案**：
1. 减少 `max` 或 `WEB_SEARCH_MAX_CAP`
2. 调整 `WEB_QUERY_CONCURRENCY`
3. 关闭不需要的来源，保留 `deepseek` 与行业定向源

## 💡 最佳实践

1. **明确的查询**：包含实体名称、时间范围、指标类型
   - ✅ 好：`2026年MTBE产能利用率`
   - ❌ 差：`化工品数据`

2. **监控来源**：查看响应中的 `sourcesUsed`，确认 DeepSeek、Tavily、百度及定向行业源是否返回。

3. **缓存策略**：相同查询可以考虑缓存结果

## 📚 相关文件

- `backend/webSearchTool.js` - 旧版工具实现（当前请求路径不调用）
- `backend/llmClientWithTools.js` - 旧版工具调用客户端（当前请求路径不调用）
- `backend/synthesizeWithTools.js` - 兼容旧智能入口，当前只做无工具综合
- `backend/index.js` - API路由（`/api/v1/search/smart`）
- `backend/test/smartSearch.test.js` - 测试脚本

## 🎉 总结

项目会在请求发送后自动并行检索多路来源，再由模型综合统一结果。旧的 `web_search` 文件仍保留作兼容，但不会被当前请求流程调用。

---

**更新时间**: 2026-10-13  
**版本**: v1.0
