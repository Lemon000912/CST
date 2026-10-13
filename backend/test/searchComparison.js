#!/usr/bin/env node

/**
 * 搜索效果对比测试工具
 * 用于对比改进前后的搜索覆盖度
 */

import {
  extractRequestedWebEntities,
  buildEntityCoverageQueries,
  shouldUseWebSearchAgent,
} from "../webSearchAgent.js";

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

// 测试用例：14种化工品产能利用率查询
const TEST_QUERIES = [
  {
    name: "14种化工品产能利用率查询",
    query: `2023年产能利用率低于75%的14种化工品：1-丁烯、MTBE、裂解C9、苯乙烯、环氧乙烷、二甲苯、甲苯、丁二烯、PO、DEG、MEG、PX、烷基化油、硫磺，查询这些产品在2026年的产能利用率`,
    expectedEntities: 14,
    expectedMinQueries: 12,
  },
  {
    name: "多产品价格查询",
    query: "查询2026年铜、铝、锌、铅、镍、锡这6种金属的价格走势",
    expectedEntities: 6,
    expectedMinQueries: 6,
  },
  {
    name: "多地区GDP查询",
    query: "2025年北京、上海、广州、深圳、成都、杭州、武汉、西安这8个城市的GDP数据",
    expectedEntities: 8,
    expectedMinQueries: 8,
  },
];

function printSection(title) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${BLUE}${title}${RESET}`);
  console.log(`${"=".repeat(60)}\n`);
}

function printSuccess(text) {
  console.log(`${GREEN}✓${RESET} ${text}`);
}

function printWarning(text) {
  console.log(`${YELLOW}⚠${RESET} ${text}`);
}

function printError(text) {
  console.log(`${RED}✗${RESET} ${text}`);
}

function printInfo(text) {
  console.log(`${BLUE}ℹ${RESET} ${text}`);
}

function analyzeQuery(testCase) {
  printSection(`测试：${testCase.name}`);

  console.log(`用户问题：\n${testCase.query}\n`);

  // 1. 实体提取测试
  printInfo("1️⃣  实体提取");
  const entities = extractRequestedWebEntities(testCase.query);
  console.log(`提取到 ${entities.length} 个实体：`);
  entities.forEach((entity, i) => {
    console.log(`   ${i + 1}. ${entity}`);
  });

  if (entities.length >= testCase.expectedEntities) {
    printSuccess(`实体提取完整 (${entities.length}/${testCase.expectedEntities})`);
  } else {
    printWarning(`部分实体缺失 (${entities.length}/${testCase.expectedEntities})`);
  }

  // 2. 触发条件检查
  printInfo("\n2️⃣  AI搜索规划触发条件");
  const shouldTrigger = shouldUseWebSearchAgent(testCase.query);
  if (shouldTrigger) {
    printSuccess("符合触发条件（实体数>=4且包含指标意图）");
  } else {
    printWarning("不符合触发条件，将使用规则式查询");
  }

  // 3. 覆盖查询生成
  printInfo("\n3️⃣  实体覆盖查询生成");
  const coverageQueries = buildEntityCoverageQueries(testCase.query, 24);
  console.log(`生成 ${coverageQueries.length} 条覆盖查询：`);
  coverageQueries.slice(0, 8).forEach((q, i) => {
    console.log(`   ${i + 1}. ${q}`);
  });
  if (coverageQueries.length > 8) {
    console.log(`   ... 还有 ${coverageQueries.length - 8} 条查询`);
  }

  if (coverageQueries.length >= testCase.expectedMinQueries) {
    printSuccess(`查询数量充足 (${coverageQueries.length}/${testCase.expectedMinQueries})`);
  } else {
    printError(`查询数量不足 (${coverageQueries.length}/${testCase.expectedMinQueries})`);
  }

  // 4. 查询质量分析
  printInfo("\n4️⃣  查询质量分析");

  const hasMetric = coverageQueries.some(q =>
    /产能利用率|价格|GDP|开工率|销量|库存/.test(q)
  );
  const hasYear = coverageQueries.some(q => /20\d{2}/.test(q));
  const diversity = new Set(coverageQueries).size / coverageQueries.length;

  console.log(`   包含指标词: ${hasMetric ? GREEN + "是" + RESET : RED + "否" + RESET}`);
  console.log(`   包含年份: ${hasYear ? GREEN + "是" + RESET : RED + "否" + RESET}`);
  console.log(`   查询多样性: ${(diversity * 100).toFixed(1)}% ${diversity >= 0.9 ? GREEN + "(优秀)" + RESET : diversity >= 0.7 ? YELLOW + "(一般)" + RESET : RED + "(较差)" + RESET}`);

  return {
    entities,
    coverageQueries,
    shouldTrigger,
    metrics: {
      entityCoverage: entities.length / testCase.expectedEntities,
      queryCount: coverageQueries.length,
      hasMetric,
      hasYear,
      diversity,
    },
  };
}

function printConfigRecommendations() {
  printSection("配置建议");

  const currentConfig = {
    WEB_AI_SEARCH_PLANNER: process.env.WEB_AI_SEARCH_PLANNER || "未设置",
    WEB_AI_SEARCH_QUERY_MAX: process.env.WEB_AI_SEARCH_QUERY_MAX || "未设置",
    WEB_ENTITY_QUERY_MAX: process.env.WEB_ENTITY_QUERY_MAX || "未设置",
    WEB_MULTI_QUERY_MAX: process.env.WEB_MULTI_QUERY_MAX || "未设置",
    WEB_ROUND2_QUERY_MAX: process.env.WEB_ROUND2_QUERY_MAX || "未设置",
  };

  const recommendedConfig = {
    WEB_AI_SEARCH_PLANNER: "1",
    WEB_AI_SEARCH_QUERY_MAX: "8",
    WEB_ENTITY_QUERY_MAX: "24",
    WEB_MULTI_QUERY_MAX: "16",
    WEB_ROUND2_QUERY_MAX: "4",
  };

  console.log("当前配置 vs 推荐配置：\n");

  Object.keys(recommendedConfig).forEach(key => {
    const current = currentConfig[key];
    const recommended = recommendedConfig[key];
    const isGood = current === recommended;
    const status = isGood ? GREEN + "✓" + RESET : YELLOW + "→" + RESET;

    console.log(`${status} ${key}`);
    console.log(`   当前: ${current}`);
    if (!isGood) {
      console.log(`   建议: ${recommended}`);
    }
  });
}

function printComparisonTable(results) {
  printSection("对比总结");

  console.log("测试用例性能对比：\n");
  console.log("┌─────────────────────┬──────────┬──────────┬──────────┐");
  console.log("│ 测试用例            │ 实体覆盖 │ 查询数量 │ 多样性   │");
  console.log("├─────────────────────┼──────────┼──────────┼──────────┤");

  results.forEach(result => {
    const name = result.name.padEnd(20, " ");
    const coverage = `${(result.metrics.entityCoverage * 100).toFixed(0)}%`.padStart(8, " ");
    const queries = String(result.metrics.queryCount).padStart(8, " ");
    const diversity = `${(result.metrics.diversity * 100).toFixed(0)}%`.padStart(8, " ");

    console.log(`│ ${name} │${coverage} │${queries} │${diversity} │`);
  });

  console.log("└─────────────────────┴──────────┴──────────┴──────────┘");

  // 计算平均值
  const avgCoverage = results.reduce((sum, r) => sum + r.metrics.entityCoverage, 0) / results.length;
  const avgQueries = results.reduce((sum, r) => sum + r.metrics.queryCount, 0) / results.length;
  const avgDiversity = results.reduce((sum, r) => sum + r.metrics.diversity, 0) / results.length;

  console.log(`\n平均性能：`);
  console.log(`  实体覆盖率: ${(avgCoverage * 100).toFixed(1)}%`);
  console.log(`  平均查询数: ${avgQueries.toFixed(1)} 条`);
  console.log(`  平均多样性: ${(avgDiversity * 100).toFixed(1)}%`);

  if (avgCoverage >= 0.9 && avgQueries >= 8 && avgDiversity >= 0.8) {
    printSuccess("\n整体性能优秀！");
  } else if (avgCoverage >= 0.7 && avgQueries >= 6) {
    printWarning("\n整体性能良好，仍有优化空间");
  } else {
    printError("\n整体性能需要改进");
  }
}

function printNextSteps() {
  printSection("后续步骤");

  console.log("1. 启动服务并测试真实搜索：");
  console.log("   npm start");
  console.log("");
  console.log("2. 使用以下问题测试搜索效果：");
  console.log('   "2023年产能利用率低于75%的14种化工品：..., 查询2026年数据"');
  console.log("");
  console.log("3. 查看搜索日志：");
  console.log("   tail -f logs/search.log | grep 'web_ai_plan\\|entity_covered'");
  console.log("");
  console.log("4. 对比结果：");
  console.log("   - 检查返回的实体数量：应>=12/14");
  console.log("   - 检查数据完整性：每个实体都应有相关信息");
  console.log("   - 检查查询策略：日志中应显示AI规划的查询");
  console.log("");
  console.log("5. 调优参数：");
  console.log("   根据实际效果调整 .env 中的配置参数");
}

// 主函数
async function main() {
  console.clear();
  printSection("🔍 联网搜索功能增强 - 效果验证工具");

  console.log("本工具用于验证搜索增强功能的效果\n");
  console.log("主要验证点：");
  console.log("  ✓ 实体提取准确性");
  console.log("  ✓ 查询生成数量");
  console.log("  ✓ 查询多样性");
  console.log("  ✓ 配置合理性");

  // 运行所有测试
  const results = [];

  for (const testCase of TEST_QUERIES) {
    const result = analyzeQuery(testCase);
    results.push({
      name: testCase.name,
      ...result,
    });
  }

  // 打印配置建议
  printConfigRecommendations();

  // 打印对比表
  printComparisonTable(results);

  // 打印后续步骤
  printNextSteps();

  printSection("测试完成");
}

// 运行
main().catch(error => {
  console.error(`${RED}错误：${error.message}${RESET}`);
  process.exit(1);
});
