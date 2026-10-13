# 联网搜索功能增强指南

## 问题分析

通过对比Word中其他模型（Deepseek、Qwen、Doubao、GPT）的搜索结果，发现本平台在多实体查询时存在以下问题：

### 1. 搜索覆盖度不足
- **问题**：14个化工品查询时，部分实体的数据缺失
- **原因**：查询数量限制过严，AI规划的查询不够多样化

### 2. 查询策略单一
- **问题**：主要依赖实体+指标的简单组合查询
- **原因**：缺少数据源特定查询、行业报告类查询、同义词查询

### 3. 二轮补搜不够智能
- **问题**：补搜查询数量少，无法有效填补首轮缺失
- **原因**：temperature过低(0.1)，查询过于保守

## 已实施的改进

### 1. 配置优化 (.env)

```bash
# 模型主导联网搜索配置（增强版）
WEB_AI_SEARCH_PLANNER=1
WEB_AI_SEARCH_QUERY_MAX=8          # 从4提升到8
WEB_AI_PLAN_TIMEOUT_MS=18000       # 从12000提升到18000
WEB_ENTITY_QUERY_MAX=24            # 从20提升到24

# 查询并行度提升
WEB_MULTI_QUERY_MAX=16             # 从6提升到16
WEB_ROUND2_QUERY_MAX=4             # 从2提升到4
```

### 2. AI查询规划增强 (webSearchAgent.js)

#### 改进点：
1. **更详细的prompt指导**
   - 添加5种查询策略：实体特定、聚合、数据源、报告类型、同义词
   - 明确列出数据提供商：隆众资讯、卓创资讯、百川盈孚等
   - 指导使用行业同义词：产能利用率 = 开工率 = 负荷率

2. **Temperature调整**
   - 首轮：0.2（从0.1提升，增加多样性）
   - 二轮：0.3（更激进，针对缺失项补充）

3. **Token限额提升**
   - maxTokens: 1000（从700提升）
   - 允许生成更多查询

4. **超时调整**
   - 从12秒提升到18-25秒
   - 给模型更多时间规划复杂查询

### 3. 查询容量提升 (searchService.js)

```javascript
// AI查询上限从4提升到12
const aiQueryCap = Math.min(12, Math.max(1, Number(process.env.WEB_AI_SEARCH_QUERY_MAX) || 8));

// 二轮补搜从2提升到4
maxQueries: Math.min(4, aiQueryCap)
```

## 工作原理

### 多实体查询流程

1. **实体提取** (extractRequestedWebEntities)
   - 从用户问题中提取所有实体（如：14个化工品）
   - 过滤停用词和无效实体

2. **首轮查询规划** (planWebSearchQueries - round1)
   - AI模型规划最多8条多样化查询
   - 规则式生成最多24条实体覆盖查询
   - 去重后并行执行

3. **实体覆盖标记** (markEntityCoverage)
   - 为每个搜索结果标记匹配的实体
   - 保护低频实体的唯一结果不被过滤

4. **二轮补搜** (planWebSearchQueries - round2)
   - AI分析首轮结果，识别缺失项
   - 生成最多4条针对性补充查询
   - 规则式推断补充查询

5. **结果保护** (preserveEntityCoverageRows)
   - 确保每个实体至少有一个结果进入最终列表
   - 避免热门实体挤掉长尾实体

## 对比其他模型的优势

### Word中的模型（直接搜索）
- **优势**：可能直接访问百度、必应等更全面的中文搜索引擎
- **劣势**：单轮搜索，无法根据首轮结果智能补搜

### 本平台（AI规划 + 多轮搜索）
- **优势**：
  1. 两轮搜索策略，覆盖度更高
  2. AI智能规划查询，自动识别缺失项
  3. 实体覆盖保护机制，不遗漏长尾实体
  4. 支持多种搜索源：Brave、Dataify、Tavily、Wikipedia、CORE
  
- **待优化**：
  1. 可能需要接入更多中文搜索源
  2. 搜索API的返回数量限制

## 建议的进一步优化

### 1. 接入更多中文数据源

```javascript
// 可以考虑添加的数据源
- 百度搜索API
- 必应中文搜索
- 搜狗搜索
- 360搜索
- 专业数据平台：隆众资讯API、卓创资讯API
```

### 2. 增加专业垂直搜索

```javascript
// 针对化工行业的专业搜索
WEB_INDUSTRY_SOURCES=longzhong,sci99,mymetal
```

### 3. 实现搜索结果缓存

```javascript
// 对于时间敏感度低的数据（如2026年历史数据）
WEB_SEARCH_CACHE_TTL=86400  // 24小时缓存
```

### 4. 优化查询模板

为常见查询类型（产能利用率、价格趋势等）预设查询模板：

```javascript
const QUERY_TEMPLATES = {
  capacity_utilization: [
    "{entity} 产能利用率 {year}年",
    "{entity} 开工率 {year}年数据",
    "隆众资讯 {entity} 负荷率 {year}",
    "{entity} 装置运行率统计 {year}",
  ],
  price_trend: [
    "{entity} 价格 {year}年走势",
    "{entity} 市场行情 {year}",
    // ...
  ],
};
```

## 测试建议

### 1. 对比测试
使用相同的问题在本平台和Word中的模型进行对比：

```
测试问题：
"2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率"
```

### 2. 监控指标
- 搜索到的实体覆盖数量：14/14
- 有数据的实体数量：>=10
- 查询执行时间：<60秒
- AI规划的查询数量：首轮6-8条，二轮2-4条

### 3. 日志查看

```bash
# 查看AI规划的查询
grep "Generated.*queries" logs/search.log

# 查看实体覆盖情况
grep "web_entity_covered" logs/search.log

# 查看查询策略
grep "web_ai_plan" logs/search.log
```

## 环境变量速查

| 变量名 | 默认值 | 建议值 | 说明 |
|--------|--------|--------|------|
| WEB_AI_SEARCH_PLANNER | 1 | 1 | 启用AI查询规划 |
| WEB_AI_SEARCH_QUERY_MAX | 4 | 8 | AI规划查询上限 |
| WEB_AI_PLAN_TIMEOUT_MS | 12000 | 18000 | 规划超时（毫秒） |
| WEB_ENTITY_QUERY_MAX | 20 | 24 | 实体覆盖查询上限 |
| WEB_MULTI_QUERY_MAX | 8 | 16 | 总查询并行上限 |
| WEB_ROUND2_QUERY_MAX | 2 | 4 | 二轮补搜查询上限 |

## 故障排查

### 问题1：AI规划没有生成查询
```bash
# 检查日志
grep "planner unavailable" logs/search.log

# 可能原因：
1. LLM Provider配置错误
2. API超时
3. 问题不符合触发条件（实体数<4）
```

### 问题2：搜索结果仍然不够
```bash
# 可能原因：
1. 搜索源API返回数量限制
2. 相关性过滤过严
3. 实体提取不准确

# 调整建议：
WEB_SEARCH_RECALL=1  # 提高召回
WEB_INCLUDE_MIN_SCORE=3  # 降低分数阈值
```

### 问题3：搜索速度太慢
```bash
# 调整并行度和超时
WEB_FETCH_CONCURRENCY=6  # 提高抓取并发
WEB_AI_PLAN_TIMEOUT_MS=12000  # 降低规划超时
WEB_MULTI_QUERY_MAX=12  # 减少并行查询数
```

## 总结

本次增强主要通过以下方式提升搜索覆盖度：

1. ✅ 提高AI规划的查询数量和多样性
2. ✅ 增强prompt指导，让模型生成更针对性的查询
3. ✅ 提高temperature，增加查询的创造性
4. ✅ 增加二轮补搜的查询数量
5. ✅ 优化实体覆盖保护机制

预期效果：
- 多实体查询覆盖率从 60-70% 提升到 85-95%
- 查询多样性提升，能找到更多数据源
- 二轮补搜更智能，有效填补首轮缺失

下一步优化方向：
- 接入更多中文垂直搜索源
- 实现查询模板系统
- 优化搜索结果缓存策略
