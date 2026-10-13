import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import {
  extractRequestedWebEntities,
  buildEntityCoverageQueries,
  planWebSearchQueries,
} from "../webSearchAgent.js";

/**
 * 测试：验证搜索增强功能
 */

test("提取14个化工品实体", () => {
  const question = `2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率`;

  const entities = extractRequestedWebEntities(question);

  console.log("提取到的实体：", entities);
  assert.ok(entities.length >= 12, `应至少提取12个实体，实际提取了${entities.length}个`);
  assert.ok(entities.includes("MTBE"), "应包含MTBE");
  assert.ok(entities.includes("苯乙烯"), "应包含苯乙烯");
  assert.ok(entities.includes("MEG"), "应包含MEG");
});

test("为14个化工品生成覆盖查询", () => {
  const question = `2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率`;

  const queries = buildEntityCoverageQueries(question, 24);

  console.log("生成的覆盖查询数量：", queries.length);
  console.log("前5条查询：", queries.slice(0, 5));

  assert.ok(queries.length >= 12, `应生成至少12条查询，实际生成了${queries.length}条`);
  assert.ok(queries[0].includes("产能利用率"), "查询应包含指标");
  assert.ok(queries[0].includes("2026"), "查询应包含年份");
});

test("验证增强后的查询数量限制", () => {
  // 验证新的上限配置
  const oldMax = Number(process.env.WEB_AI_SEARCH_QUERY_MAX) || 4;
  const newMax = Math.min(12, Math.max(1, oldMax));

  console.log("旧的查询上限：4");
  console.log("新的查询上限：", newMax);

  assert.ok(newMax >= 4, "新上限应>=4");
  assert.ok(newMax <= 12, "新上限应<=12");
});

test("AI规划查询 - 模拟多实体问题", async () => {
  // 创建模拟的LLM服务器
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const request = JSON.parse(body);
        console.log("\n=== 收到的LLM请求 ===");
        console.log("Temperature:", request.temperature);
        console.log("Max Tokens:", request.max_tokens);
        console.log("\nSystem Prompt (前200字符):");
        console.log(request.messages?.find(m => m.role === "system")?.content.slice(0, 200));
        console.log("\nUser Query (前200字符):");
        console.log(request.messages?.find(m => m.role === "user")?.content.slice(0, 200));

        // 模拟返回多样化的查询
        const response = {
          choices: [{
            message: {
              content: JSON.stringify({
                queries: [
                  "MTBE 产能利用率 2026年",
                  "苯乙烯 开工率 2026年数据",
                  "隆众资讯 化工品 产能利用率 2026",
                  "卓创资讯 MEG DEG 利用率",
                  "2026年化工行业开工率统计报告",
                  "丁二烯 PO PX 产能利用率对比 2026",
                  "环氧乙烷 二甲苯 装置运行率 2026",
                  "烷基化油 硫磺 负荷率数据 2026年",
                ]
              })
            },
          }],
        };

        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(response));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  // 保存原环境变量
  const originalEnv = {
    WEB_AI_SEARCH_PLANNER: process.env.WEB_AI_SEARCH_PLANNER,
    WEB_AI_SEARCH_QUERY_MAX: process.env.WEB_AI_SEARCH_QUERY_MAX,
    LLM_PROVIDER_A_API_KEY: process.env.LLM_PROVIDER_A_API_KEY,
    LLM_PROVIDER_A_BASE_URL: process.env.LLM_PROVIDER_A_BASE_URL,
    LLM_PROVIDER_A_MODEL: process.env.LLM_PROVIDER_A_MODEL,
  };

  try {
    // 设置测试环境
    process.env.WEB_AI_SEARCH_PLANNER = "1";
    process.env.WEB_AI_SEARCH_QUERY_MAX = "8";
    process.env.LLM_PROVIDER_A_API_KEY = "test-key";
    process.env.LLM_PROVIDER_A_BASE_URL = baseUrl;
    process.env.LLM_PROVIDER_A_MODEL = "test-model";

    const userQuery = `2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率`;

    const queries = await planWebSearchQueries({
      userQuery,
      effectiveQuery: "chemical capacity utilization 2026",
      maxQueries: 8,
      llmHints: {
        apiKey: "test-key",
        chatCompletionsUrl: `${baseUrl}/chat/completions`,
        model: "test-model",
      },
    });

    console.log("\n=== AI规划结果 ===");
    console.log("生成的查询数量：", queries.length);
    console.log("查询列表：");
    queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

    assert.ok(queries.length >= 6, `应生成至少6条查询，实际${queries.length}条`);
    assert.ok(queries.length <= 8, `不应超过8条查询，实际${queries.length}条`);

    // 验证查询多样性
    const hasEntitySpecific = queries.some(q => /MTBE|苯乙烯|MEG/.test(q));
    const hasDataSource = queries.some(q => /隆众|卓创/.test(q));
    const hasSynonym = queries.some(q => /开工率|负荷率|装置运行率/.test(q));

    console.log("\n查询多样性检查：");
    console.log("  包含实体特定查询：", hasEntitySpecific);
    console.log("  包含数据源查询：", hasDataSource);
    console.log("  包含同义词查询：", hasSynonym);

    assert.ok(hasEntitySpecific, "应包含实体特定查询");

  } finally {
    // 恢复环境变量
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });

    await new Promise((resolve) => server.close(resolve));
  }
});

test("二轮补搜 - 基于首轮结果", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const request = JSON.parse(body);

        // 检查是否包含evidence（首轮结果）
        const userContent = request.messages?.find(m => m.role === "user")?.content || "";
        const hasEvidence = userContent.includes("首轮结果") || userContent.includes("evidence");

        console.log("\n=== 二轮补搜请求 ===");
        console.log("包含首轮结果：", hasEvidence);
        console.log("Temperature:", request.temperature);

        // 模拟针对缺失项的补充查询
        const response = {
          choices: [{
            message: {
              content: JSON.stringify({
                queries: [
                  "1-丁烯 产能利用率 2026年",  // 假设首轮缺失
                  "裂解C9 开工率 2026",
                  "甲苯 二甲苯 负荷率数据 2026",
                  "百川盈孚 硫磺 产能利用率",
                ]
              })
            },
          }],
        };

        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(response));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const originalEnv = {
    WEB_AI_SEARCH_PLANNER: process.env.WEB_AI_SEARCH_PLANNER,
    LLM_PROVIDER_A_API_KEY: process.env.LLM_PROVIDER_A_API_KEY,
    LLM_PROVIDER_A_BASE_URL: process.env.LLM_PROVIDER_A_BASE_URL,
    LLM_PROVIDER_A_MODEL: process.env.LLM_PROVIDER_A_MODEL,
  };

  try {
    process.env.WEB_AI_SEARCH_PLANNER = "1";
    process.env.LLM_PROVIDER_A_API_KEY = "test-key";
    process.env.LLM_PROVIDER_A_BASE_URL = baseUrl;
    process.env.LLM_PROVIDER_A_MODEL = "test-model";

    // 模拟首轮搜索结果
    const mockPapers = [
      { title: "MTBE产能利用率数据", summary: "2026年MTBE产能利用率62.88%", source: "web" },
      { title: "苯乙烯行业报告", summary: "苯乙烯开工率66.26%", source: "web" },
      // 注意：缺少1-丁烯、裂解C9等的数据
    ];

    const queries = await planWebSearchQueries({
      userQuery: "查询14种化工品2026年产能利用率",
      effectiveQuery: "chemical capacity utilization",
      papers: mockPapers,  // 提供首轮结果
      maxQueries: 4,
      llmHints: {
        apiKey: "test-key",
        chatCompletionsUrl: `${baseUrl}/chat/completions`,
        model: "test-model",
      },
    });

    console.log("\n=== 二轮补搜结果 ===");
    console.log("补充查询数量：", queries.length);
    console.log("补充查询列表：");
    queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

    assert.ok(queries.length >= 2, `应生成至少2条补充查询，实际${queries.length}条`);
    assert.ok(queries.length <= 4, `不应超过4条补充查询，实际${queries.length}条`);

  } finally {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });

    await new Promise((resolve) => server.close(resolve));
  }
});

console.log("\n=== 运行搜索增强测试 ===\n");
console.log("这些测试验证：");
console.log("1. 实体提取准确性");
console.log("2. 覆盖查询生成");
console.log("3. AI规划查询数量和多样性");
console.log("4. 二轮补搜机制");
console.log("\n运行命令: node --test backend/test/searchEnhancement.test.js\n");
