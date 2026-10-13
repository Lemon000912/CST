/**
 * 增强版联网搜索Agent - 提供更智能的查询规划和多样化搜索策略
 */

import { generateText } from "./llmClient.js";
import { resolvePrimaryProvider } from "./llmProviders.js";
import {
  extractCoreSearchQuery,
  extractConversationContext,
  clampQueryForExternalApi,
} from "./searchQueryNormalize.js";
import { traceAsync } from "./performanceTrace.js";

/**
 * 增强版查询规划prompt，让模型生成更多样化的查询策略
 */
function buildEnhancedSearchPrompt(userQuery, effectiveQuery, evidence, maxQueries) {
  const system = [
    "You are an expert search strategist for a web-search system. Do not answer the user's question.",
    "Your task: generate diverse, high-coverage search queries that maximize the chance of finding Chinese industry data.",
    "",
    "Strategy for multi-entity queries (e.g., '14种化工品的产能利用率'):",
    "1. Generate entity-specific queries: '化工品A 产能利用率 2026', '化工品B 产能利用率 2026'",
    "2. Generate aggregated queries: '2026年化工行业产能利用率统计', '石化产品开工率数据'",
    "3. Generate source-specific queries: '隆众资讯 化工品 产能利用率', '卓创资讯 开工率数据'",
    "4. Generate comparison queries: '化工品产能利用率对比 2023 2026'",
    "5. Use industry terminology: '开工率', '产能利用率', '负荷率', '装置运行率'",
    "",
    "For Chinese industry data:",
    "- Include data provider names: 隆众资讯、卓创资讯、百川盈孚、我的钢铁网",
    "- Include report types: 月报、周报、行业报告、统计数据",
    "- Include specific years and time periods mentioned",
    "- Use both full names and abbreviations for products",
    "",
    "If evidence is supplied:",
    "- Identify which entities/metrics are missing or incomplete",
    "- Generate targeted queries for the gaps",
    "- Try alternative phrasings and data sources",
    "",
    `Generate ${maxQueries} diverse queries as JSON: {\"queries\":[\"...\"], \"strategy\":\"brief explanation\"}`,
    "No URLs, no answers, only search queries in Chinese.",
  ].join("\n");

  const user = [
    `用户问题：\n${String(userQuery ?? "").slice(0, 2400)}`,
    effectiveQuery ? `\n改写查询：\n${String(effectiveQuery).slice(0, 600)}` : "",
    evidence.length
      ? `\n首轮搜索结果（标题和摘录仅供参考）：\n${JSON.stringify(evidence.slice(0, 20))}`
      : "",
    evidence.length
      ? `\n请分析以上结果，找出缺失的实体或数据，并为这些缺失项生成针对性查询。`
      : "",
  ].filter(Boolean).join("\n");

  return { system, user };
}

/**
 * 解析模型返回的查询，支持更灵活的格式
 */
function parseEnhancedQueries(text, maxQueries) {
  let source = String(text ?? "").trim();

  // 移除markdown代码块标记
  source = source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // 查找JSON对象
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    source = source.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(source);
    const raw = Array.isArray(parsed) ? parsed : parsed?.queries;
    if (!Array.isArray(raw)) return { queries: [], strategy: "" };

    const seen = new Set();
    const queries = [];

    for (const item of raw) {
      const q = clampQueryForExternalApi(
        String(item ?? "").replace(/[\r\n\t]+/g, " ").trim(),
        240
      );
      const key = q.toLowerCase();

      // 过滤无效查询
      if (q.length < 5 || seen.has(key) || /^https?:\/\//i.test(q)) continue;

      seen.add(key);
      queries.push(q);

      if (queries.length >= maxQueries) break;
    }

    return {
      queries,
      strategy: String(parsed?.strategy ?? "").slice(0, 200),
    };
  } catch (error) {
    console.warn("[webSearchAgentEnhanced] JSON parse failed:", error.message);

    // 降级：尝试提取引号内的内容作为查询
    const fallbackQueries = [];
    const quoteMatches = source.matchAll(/"([^"]{10,200})"/g);
    for (const match of quoteMatches) {
      const q = match[1].trim();
      if (q.length >= 5 && !fallbackQueries.includes(q)) {
        fallbackQueries.push(q);
        if (fallbackQueries.length >= maxQueries) break;
      }
    }

    return { queries: fallbackQueries, strategy: "fallback" };
  }
}

/**
 * 增强版查询规划：使用更智能的prompt和更高的temperature
 */
export async function planEnhancedWebSearchQueries({
  userQuery,
  effectiveQuery = "",
  papers = [],
  maxQueries = 8,
  llmHints = {},
  signal,
  performanceTrace,
  traceName = "search.web.ai_plan.enhanced",
} = {}) {
  const provider = resolvePrimaryProvider(llmHints);
  if (!provider) return { queries: [], strategy: "" };

  const evidence = (Array.isArray(papers) ? papers : [])
    .slice(0, 28)
    .map((paper, index) => ({
      id: index + 1,
      title: String(paper?.title ?? "").slice(0, 180),
      source: String(paper?.source ?? "").slice(0, 40),
      excerpt: String(paper?.summary ?? paper?.abstract ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 360),
    }));

  const cap = Math.min(12, Math.max(1, Number(maxQueries) || 1));
  const { system, user } = buildEnhancedSearchPrompt(userQuery, effectiveQuery, evidence, cap);

  try {
    const result = await traceAsync(
      performanceTrace,
      traceName,
      {
        model: provider.model,
        maxQueries: cap,
        evidenceCount: evidence.length,
        round: evidence.length > 0 ? "round2" : "round1",
      },
      () => generateText(provider, {
        signal,
        timeoutMs: Math.min(25_000, Math.max(6_000, Number(process.env.WEB_AI_PLAN_TIMEOUT_MS) || 18_000)),
        // 提高temperature让查询更多样化
        temperature: evidence.length > 0 ? 0.3 : 0.2,
        maxTokens: 1200,
        system,
        messages: [{ role: "user", content: user }],
      }),
      (value) => ({
        status: value?.status,
        error: value?.error,
        outputChars: String(value?.text ?? "").length
      }),
    );

    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Search cancelled", "AbortError");
    }

    if (!result.ok) return { queries: [], strategy: "" };

    const parsed = parseEnhancedQueries(result.text, cap);

    if (parsed.queries.length > 0) {
      console.log(`[${traceName}] Generated ${parsed.queries.length} queries, strategy: ${parsed.strategy}`);
    }

    return parsed;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    console.warn(`[${traceName}] planner unavailable:`, String(error?.message ?? error).slice(0, 160));
    return { queries: [], strategy: "" };
  }
}

/**
 * 为特定数据源生成针对性查询
 */
export function generateSourceSpecificQueries(userQuery, entities, metric, period) {
  const queries = [];
  const dataSources = [
    "隆众资讯",
    "卓创资讯",
    "百川盈孚",
    "我的钢铁网",
    "生意社",
    "wind数据",
  ];

  // 为前几个实体生成数据源特定查询
  const topEntities = entities.slice(0, 5);

  for (const source of dataSources.slice(0, 3)) {
    if (topEntities.length > 0) {
      // 多实体聚合查询
      queries.push(`${source} ${topEntities.slice(0, 3).join(" ")} ${metric} ${period}`.trim());
    } else {
      // 通用查询
      queries.push(`${source} ${metric} ${period}`.trim());
    }
  }

  return queries;
}

/**
 * 生成时间序列对比查询
 */
export function generateTimeSeriesQueries(entities, metric, years) {
  const queries = [];

  if (years.length >= 2) {
    // 多年对比
    const yearStr = years.join(" ");
    queries.push(`${entities[0]} ${metric} ${yearStr} 对比`);
    queries.push(`${metric} 变化趋势 ${yearStr}`);
  }

  return queries;
}
