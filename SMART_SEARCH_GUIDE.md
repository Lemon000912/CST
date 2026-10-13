# 智能联网搜索功能使用指南

## 🎯 功能说明

新增的智能搜索功能允许**模型主动决定是否需要联网搜索**，类似于 ChatGPT、Claude 等AI助手的联网功能。

### 与原有搜索的区别

| 特性 | 原有搜索 (`/api/v1/search`) | 智能搜索 (`/api/v1/search/smart`) |
|------|---------------------------|----------------------------------|
| 搜索触发 | 固定流程，预先配置 | **模型自主决定** |
| 搜索次数 | 一次性批量搜索 | **模型可多次调用**（最多3轮） |
| 搜索策略 | 规则式查询生成 | **模型规划查询词** |
| 适用场景 | 文献检索、常规查询 | **实时数据、多实体查询、复杂问题** |

## 🚀 快速开始

### 1. 配置检查

确保 `.env` 文件中已配置：

```bash
# LLM Provider（支持Function Calling的模型）
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
  "forceWebSearch": true,        // 可选，强制启用联网搜索（默认true）
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
  "toolCalls": [                // 工具调用记录
    {
      "iteration": 1,
      "function": "web_search",
      "arguments": {
        "query": "MTBE 产能利用率 2026",
        "max_results": 10
      }
    }
  ],
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

### Q: 模型没有调用工具？

**排查步骤**：
1. 检查模型是否支持Function Calling
2. 查看日志是否有 `[llm.tools] Enabled web_search tool`
3. 确认查询是否满足触发条件
4. 尝试设置 `forceWebSearch: true`

### Q: 搜索失败？

**排查步骤**：
1. 检查搜索API Key是否配置正确
2. 查看 `[tool.web_search]` 日志
3. 确认网络连接正常
4. 检查API配额是否用完

### Q: 响应太慢？

**优化方案**：
1. 减少 `MAX_TOOL_ITERATIONS`（从3改为2）
2. 限制搜索结果数量（`max_results: 5`）
3. 使用更快的搜索源（Brave > Tavily > MCP）

## 💡 最佳实践

1. **明确的查询**：包含实体名称、时间范围、指标类型
   - ✅ 好：`2026年MTBE产能利用率`
   - ❌ 差：`化工品数据`

2. **合理设置forceWebSearch**：
   - 实时数据查询：`true`
   - 常识性问题：`false`

3. **监控Token使用**：工具调用会增加Token消耗

4. **缓存策略**：相同查询可以考虑缓存结果

## 📚 相关文件

- `backend/webSearchTool.js` - 联网搜索工具定义
- `backend/llmClientWithTools.js` - 支持工具调用的LLM客户端
- `backend/synthesizeWithTools.js` - 智能综合服务
- `backend/index.js` - API路由（`/api/v1/search/smart`）
- `backend/test/smartSearch.test.js` - 测试脚本

## 🎉 总结

智能搜索功能使模型能够**像人一样主动寻找信息**：
- 判断何时需要搜索
- 规划搜索策略
- 多轮迭代获取信息
- 综合所有信息给出答案

这就是为什么Word里的AI模型能搜到更多信息的原因！

---

**更新时间**: 2026-10-13  
**版本**: v1.0
