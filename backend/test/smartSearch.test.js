/**
 * 兼容智能搜索入口测试脚本
 * 当前入口只验证基于预先检索结果的模型综合，不再触发 web_search 工具。
 */

// 这是演示脚本，复用后端真实实现；不在 test 目录复制一份工具模块。
import { synthesizeWithAutoTools, formatToolCallsLog } from "../synthesizeWithTools.js";

// 测试用例
const TEST_CASES = [
  {
    name: "多实体产能利用率查询（使用前置检索结果）",
    query: "2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率",
    papers: [],
    forceWebSearch: true,
  },
  {
    name: "最新价格查询（使用前置检索结果）",
    query: "查询2026年10月铜的最新价格",
    papers: [],
    forceWebSearch: true,
  },
  {
    name: "有足够现有数据（可能不触发联网搜索）",
    query: "什么是人工智能？",
    papers: [
      {
        title: "人工智能综述",
        summary: "人工智能（Artificial Intelligence, AI）是计算机科学的一个分支，它企图了解智能的实质，并生产出一种新的能以人类智能相似的方式做出反应的智能机器。",
        absUrl: "https://example.com/ai-intro",
      },
    ],
    forceWebSearch: false,
  },
];

async function runTest(testCase) {
  console.log("\n" + "=".repeat(80));
  console.log(`测试: ${testCase.name}`);
  console.log("=".repeat(80));
  console.log(`问题: ${testCase.query}`);
  console.log(`现有信息: ${testCase.papers.length} 条`);
  console.log(`强制联网搜索: ${testCase.forceWebSearch}`);
  console.log("\n开始执行...\n");

  const startTime = Date.now();

  try {
    const result = await synthesizeWithAutoTools({
      query: testCase.query,
      papers: testCase.papers,
      forceWebSearch: testCase.forceWebSearch,
    });

    const elapsed = Date.now() - startTime;

    console.log("\n--- 执行结果 ---");
    console.log(`耗时: ${(elapsed / 1000).toFixed(2)}秒`);
    console.log(`模型: ${result.provider}`);
    console.log(`工具调用: ${result.toolCalls.length} 次`);

    if (result.toolCalls.length > 0) {
      console.log("\n--- 工具调用详情 ---");
      console.log(formatToolCallsLog(result.toolCalls));
    }

    console.log("\n--- 生成的回答（前500字） ---");
    console.log(result.text.slice(0, 500));
    if (result.text.length > 500) {
      console.log(`\n... (还有 ${result.text.length - 500} 个字符)`);
    }

    if (result.usage) {
      console.log("\n--- Token使用情况 ---");
      console.log(JSON.stringify(result.usage, null, 2));
    }

    console.log("\n✅ 测试通过");
    return { success: true, result };
  } catch (error) {
    console.error("\n❌ 测试失败");
    console.error("错误:", error.message);
    console.error("堆栈:", error.stack);
    return { success: false, error };
  }
}

async function main() {
  console.log("=".repeat(80));
  console.log("智能搜索功能测试");
  console.log("=".repeat(80));
  console.log("\n本测试将演示:");
  console.log("1. 请求先完成多源联网检索");
  console.log("2. 模型只基于检索结果生成答案");
  console.log("3. web_search 工具调用应保持为 0");
  console.log("\n注意: 需要配置LLM Provider和搜索API Key");

  const results = [];

  // 运行所有测试用例
  for (const testCase of TEST_CASES) {
    const result = await runTest(testCase);
    results.push(result);

    // 等待一下，避免API限流
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 总结
  console.log("\n" + "=".repeat(80));
  console.log("测试总结");
  console.log("=".repeat(80));

  const successCount = results.filter(r => r.success).length;
  console.log(`\n总计: ${results.length} 个测试`);
  console.log(`成功: ${successCount} 个`);
  console.log(`失败: ${results.length - successCount} 个`);

  if (successCount === results.length) {
    console.log("\n🎉 所有测试通过！");
  } else {
    console.log("\n⚠️ 部分测试失败，请检查配置和日志");
  }
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error("测试运行失败:", error);
    process.exit(1);
  });
}

export { runTest, TEST_CASES };
