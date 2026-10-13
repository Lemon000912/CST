# 联网搜索增强 - 快速开始

## 📋 改进总结

本次优化主要解决了多实体查询（如：14种化工品产能利用率）的搜索覆盖度问题。

### 核心改进

1. **AI规划查询数量** 4条 → 8条
2. **并行查询上限** 6条 → 16条  
3. **二轮补搜** 2条 → 4条
4. **实体覆盖查询** 20条 → 24条
5. **查询多样性** temperature 0.1 → 0.2/0.3
6. **Prompt优化** 增加5种查询策略指导

## 🚀 快速验证

### 1. 运行对比测试

```bash
node backend/test/searchComparison.js
```

这个工具会：
- ✅ 测试实体提取准确性
- ✅ 验证查询生成数量
- ✅ 分析查询多样性
- ✅ 对比配置合理性

### 2. 运行单元测试

```bash
npm test backend/test/searchEnhancement.test.js
```

测试覆盖：
- 实体提取
- 覆盖查询生成
- AI规划机制
- 二轮补搜逻辑

### 3. 测试真实搜索

启动服务：
```bash
npm start
```

使用测试问题：
```
2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率
```

查看日志：
```bash
# Windows PowerShell
Get-Content logs\search.log -Tail 50 -Wait | Select-String "web_ai_plan|entity_covered"

# Linux/Mac
tail -f logs/search.log | grep "web_ai_plan\|entity_covered"
```

## 📊 预期效果

### 改进前
- 实体覆盖：8-10/14 (57-71%)
- 查询策略：单一
- 二轮补搜：有限

### 改进后
- 实体覆盖：12-14/14 (85-100%)
- 查询策略：5种策略组合
  1. 实体特定：`MTBE 产能利用率 2026`
  2. 数据源：`隆众资讯 化工品 产能利用率`
  3. 聚合查询：`2026年化工行业产能利用率统计`
  4. 报告类型：`化工品开工率月报 2026`
  5. 同义词：`开工率/负荷率/装置运行率`
- 二轮补搜：智能识别缺失项

## 🔍 关键日志说明

搜索过程中会看到这些日志：

```
[search.web.ai_plan.round1] Generated 8 queries (round 1)
```
表示AI规划了8条首轮查询

```
web_entity_coverage:14
```
表示为14个实体生成了覆盖查询

```
web_entity_covered:12/14
```
表示14个实体中有12个找到了数据

```
[search.web.ai_plan.round2] Generated 4 queries (round 2)
```
表示AI规划了4条补搜查询

## ⚙️ 配置调优

如果效果不理想，可以尝试调整：

### 提高查询数量（增加覆盖度，但更慢）
```bash
WEB_AI_SEARCH_QUERY_MAX=12
WEB_ENTITY_QUERY_MAX=30
WEB_MULTI_QUERY_MAX=20
```

### 降低查询数量（更快，但可能遗漏）
```bash
WEB_AI_SEARCH_QUERY_MAX=6
WEB_ENTITY_QUERY_MAX=16
WEB_MULTI_QUERY_MAX=12
```

### 调整召回策略
```bash
# 高召回（更多结果，可能有噪音）
WEB_SEARCH_RECALL=1
WEB_INCLUDE_MIN_SCORE=3

# 高精准（更少结果，更相关）
WEB_SEARCH_RECALL=0
WEB_INCLUDE_MIN_SCORE=6
```

## 🐛 故障排查

### 问题1：AI没有规划查询

**症状**：日志中没有 `web_ai_plan` 相关信息

**检查**：
```bash
# 1. 确认配置已启用
grep WEB_AI_SEARCH_PLANNER .env

# 2. 确认LLM配置正确
grep LLM_PROVIDER_A .env

# 3. 查看错误日志
grep "planner unavailable" logs/search.log
```

**解决**：
- 确保 `WEB_AI_SEARCH_PLANNER=1`
- 确保LLM Provider配置正确且可访问
- 检查API Key是否有效

### 问题2：搜索结果仍然不够

**症状**：`web_entity_covered:6/14` 覆盖率低

**可能原因**：
1. 搜索源返回数量不足
2. 实体提取不准确
3. 查询词不够准确

**检查**：
```bash
# 查看提取的实体
node -e "
import {extractRequestedWebEntities} from './backend/webSearchAgent.js';
const entities = extractRequestedWebEntities('你的问题');
console.log(entities);
"
```

**解决**：
- 检查 `WEB_SOURCES` 配置，确保有足够搜索源
- 提高 `WEB_SEARCH_MAX_CAP` 增加结果数量
- 调整实体提取逻辑（如果实体提取有误）

### 问题3：搜索太慢

**症状**：查询超过60秒

**检查当前配置**：
```bash
grep -E "WEB_.*TIMEOUT|WEB_MULTI_QUERY_MAX|WEB_AI.*QUERY_MAX" .env
```

**优化**：
```bash
# 减少查询数量
WEB_AI_SEARCH_QUERY_MAX=6
WEB_MULTI_QUERY_MAX=10

# 减少超时时间
WEB_AI_PLAN_TIMEOUT_MS=10000
WEB_SEARCH_LAYER_TIMEOUT_MS=50000
```

## 📈 效果监控

建议监控以下指标：

### 搜索覆盖率
```bash
# 统计最近100次搜索的平均覆盖率
grep "web_entity_covered" logs/search.log | tail -100 | \
  awk -F: '{split($NF, a, "/"); sum+=a[1]/a[2]; count++} END {print "平均覆盖率:", sum/count*100"%"}'
```

### AI规划成功率
```bash
# 统计AI规划成功的次数
grep "web_ai_plan.*Generated" logs/search.log | wc -l
```

### 查询响应时间
```bash
# 查看搜索耗时
grep "search.*duration" logs/search.log | tail -20
```

## 📚 更多文档

- 详细说明：[SEARCH_ENHANCEMENT_GUIDE.md](./SEARCH_ENHANCEMENT_GUIDE.md)
- 测试代码：[backend/test/searchEnhancement.test.js](./backend/test/searchEnhancement.test.js)
- 对比工具：[backend/test/searchComparison.js](./backend/test/searchComparison.js)

## 💡 最佳实践

1. **对于多实体查询**：确保实体数>=4，系统会自动触发增强搜索
2. **明确指标和年份**：如"2026年产能利用率"比"利用率"效果更好
3. **使用行业术语**：系统会自动识别同义词（开工率=产能利用率）
4. **定期查看日志**：监控覆盖率和AI规划成功率

## 🤝 反馈

如果遇到问题或有改进建议，请查看日志文件并记录：
- 测试问题
- 预期结果
- 实际结果
- 相关日志片段

这样可以帮助快速定位和解决问题。
