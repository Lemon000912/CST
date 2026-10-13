import { generateText } from "./llmClient.js";
import { resolvePrimaryProvider } from "./llmProviders.js";
import {
  extractCoreSearchQuery,
  extractConversationContext,
  clampQueryForExternalApi,
} from "./searchQueryNormalize.js";
import { traceAsync } from "./performanceTrace.js";

const METRIC_INTENT_RE = /数据|数值|指标|产能利用率|利用率|开工率|开工|产量|价格|销量|份额|成本|库存|趋势|统计|对比|变化|多少|如何|情况/;

const ENTITY_STOP_WORDS = new Set([
  "这些", "分别", "以及", "相关", "国内", "中国", "请问", "帮我", "查询", "一下",
  "化工品", "化工产品", "产品", "品种", "数据", "数值", "指标", "产能利用率", "利用率",
  "开工率", "开工", "情况", "是多少", "哪些", "如下", "其中", "当前", "今年", "去年",
]);

/**
 * 从"多个产品/实体 + 指标"的自然语言问题中提取实体。这里故意使用
 * 列表标点和常见引导词，而不是让搜索模型决定覆盖范围，避免 14 个产品
 * 被压缩成 3～4 条泛化查询。
 */
export function extractRequestedWebEntities(query) {
  const raw = extractCoreSearchQuery(String(query ?? "").trim()) || String(query ?? "").trim();
  if (!raw) return [];

  // 优先识别"...的有X、Y、Z"或"包括X、Y、Z"模式
  const hasPattern = raw.match(/(?:的有|包括|分别是|为[:：]?)\s*([^，。！？!?.]+[、，,；;][^。！？!?.]+)/);
  if (hasPattern && hasPattern[1]) {
    return parseEntityList(hasPattern[1]);
  }

  // 冒号后的部分通常就是用户列出的产品清单（"请查询……：A、B、C"）。
  const colon = Math.max(raw.lastIndexOf("："), raw.lastIndexOf(":"));
  if (colon >= 0) {
    return parseEntityList(raw.slice(colon + 1));
  }

  // 没有冒号时，取最后一个指标前的部分（"A、B、C 的产能利用率"）
  const metricMatches = [...raw.matchAll(/(?:的)?(?:产能利用率|利用率|开工率|产量|价格|销量|份额|成本|库存|趋势|统计|数据|数值)/g)];
  const lastMetric = metricMatches[metricMatches.length - 1];
  const list = lastMetric && lastMetric.index > 0 ? raw.slice(0, lastMetric.index) : raw;

  return parseEntityList(list);
}

function parseEntityList(list) {
  list = list
    .replace(/^(?:请|帮我|麻烦|查询|检索|列出|统计|获取)\s*/g, "")
    .replace(/^(?:以下|如下|这些|相关的?)\s*/g, "")
    .replace(/[，,]\s*(?:请?查询|统计|获取|求)\s*[^、，,；;]*$/g, "")
    .replace(/[（(][^）)]*(?:年|季度|月份|低于|高于|超过|达到|截至|统计)[^）)]*[）)]/g, " ");
  const parts = list
    .split(/[、，,；;\n]|\s+(?:和|及|与|以及)\s+/)
    .map((part) => part
      .replace(/^[\s\d.、，,；;：:()（）\[\]【】-]+|[\s。？！?：:()（）\[\]【】-]+$/g, "")
      .replace(/(?:低于|高于|超过|达到|约|大约)\s*[\d.]+\s*%?/g, "")
      .replace(/[的之]$/g, "")
      .trim())
    .filter((part) => {
      if (part.length < 2 || part.length > 40) return false;
      if (/^\d+(?:年|季度|月)?$/.test(part) || /^\d+(?:\.\d+)?%?$/.test(part)) return false;
      if (ENTITY_STOP_WORDS.has(part)) return false;
      if (/^(?:的|和|及|与|这些|各类|所有|目前|需要|请)\b/.test(part)) return false;
      return /[\u4e00-\u9fffA-Za-z]/.test(part);
    });
  return [...new Set(parts)];
}

function extractSearchPeriod(query) {
  const m = String(query ?? "").match(/(?:20\d{2}|19\d{2})(?:年)?(?:第?[一二三四1-4]季度|年)?/g);
  return m?.[m.length - 1] || "";
}

function extractSearchMetric(query) {
  const s = String(query ?? "");
  for (const metric of ["产能利用率", "开工率", "利用率", "产量", "价格", "销量", "库存", "市场份额", "成本"]) {
    if (s.includes(metric)) return metric;
  }
  return "数据";
}

/** 为每个实体生成至少一条带指标/年份的定向查询。 */
export function buildEntityCoverageQueries(query, maxQueries = 20) {
  const entities = extractRequestedWebEntities(query);
  if (entities.length < 4) return [];
  const metric = extractSearchMetric(query);
  const period = extractSearchPeriod(query);
  const suffix = [metric, period].filter(Boolean).join(" ");
  const cap = Math.min(32, Math.max(1, Number(maxQueries) || 20));
  return entities.slice(0, cap).map((entity) => `${entity} ${suffix}`.trim());
}

/** 给候选页面打上实体覆盖标记，后续相关性过滤不得把唯一命中项全部丢掉。 */
export function markEntityCoverage(papers, query) {
  const entities = extractRequestedWebEntities(query);
  if (!entities.length) return Array.isArray(papers) ? papers : [];
  return (Array.isArray(papers) ? papers : []).map((paper) => {
    const text = `${paper?.title ?? ""} ${paper?.summary ?? paper?.abstract ?? ""} ${paper?.absUrl ?? ""}`;
    const matched = entities.filter((entity) => text.includes(entity));
    return matched.length ? { ...paper, _matchedEntities: matched, _entityCoverage: true } : paper;
  });
}

/** Only invoke the extra planner for a genuinely multi-entity factual request. */
export function shouldUseWebSearchAgent(query) {
  const raw = extractCoreSearchQuery(String(query ?? "").trim()) || String(query ?? "").trim();
  if (!raw || !METRIC_INTENT_RE.test(raw)) return false;
  return extractRequestedWebEntities(raw).length >= 4;
}

function hasMultipleEntities(query) {
  return extractRequestedWebEntities(query).length >= 4;
}

function parseQueries(text, maxQueries) {
  let source = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) source = source.slice(start, end + 1);
  try {
    const parsed = JSON.parse(source);
    const raw = Array.isArray(parsed) ? parsed : parsed?.queries;
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      const q = clampQueryForExternalApi(String(item ?? "").replace(/[\r\n\t]+/g, " ").trim(), 240);
      const key = q.toLowerCase();
      if (q.length < 5 || seen.has(key) || /^https?:\/\//i.test(q)) continue;
      seen.add(key);
      out.push(q);
      if (out.length >= maxQueries) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Ask the configured search model to plan bounded web queries or target remaining gaps. */
export function isWebSearchAgentEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.WEB_AI_SEARCH_PLANNER ?? "1").trim());
}

export async function planWebSearchQueries({
  userQuery,
  effectiveQuery = "",
  papers = [],
  maxQueries = 6,
  llmHints = {},
  signal,
  performanceTrace,
  traceName = "search.web.ai_plan",
} = {}) {
  const provider = resolvePrimaryProvider(llmHints);
  if (!isWebSearchAgentEnabled() || !provider) return [];
  const promptQuery = String(userQuery ?? "").trim();
  const context = extractConversationContext(promptQuery);
  const currentQuestion = extractCoreSearchQuery(promptQuery) || promptQuery;
  const intentQuery = context ? `${context}\n${currentQuestion}` : promptQuery;
  if (!shouldUseWebSearchAgent(intentQuery) && !(papers.length && hasMultipleEntities(intentQuery))) return [];
  const cap = Math.min(12, Math.max(1, Number(maxQueries) || 1));
  const evidence = (Array.isArray(papers) ? papers : [])
    .slice(0, 28)
    .map((paper, index) => ({
      id: index + 1,
      title: String(paper?.title ?? "").slice(0, 180),
      source: String(paper?.source ?? "").slice(0, 40),
      excerpt: String(paper?.summary ?? paper?.abstract ?? "").replace(/\s+/g, " ").slice(0, 360),
    }));

  // 增强版prompt：更详细的搜索策略指导
  const system = [
    "You are an expert search strategist for a Chinese web-search system. Do not answer the user's question.",
    "Your goal: generate diverse search queries that maximize coverage of requested entities, metrics, and time periods.",
    "",
    "Strategy for multi-entity queries:",
    "1. Entity-specific queries: include each entity name + metric + year",
    "2. Aggregated queries: industry overview + metric + year",
    "3. Data-source queries: '隆众资讯/卓创资讯/百川盈孚 + entities + metric'",
    "4. Report-type queries: '行业报告/月报/统计数据 + metric + year'",
    "5. Use industry synonyms: '产能利用率' = '开工率' = '负荷率' = '装置运行率'",
    "",
    "For Chinese industry data:",
    "- Include data providers: 隆众资讯, 卓创资讯, 百川盈孚, 我的钢铁网, 生意社",
    "- Include specific years and exact metric names",
    "- Use both full names and common abbreviations",
    "",
    evidence.length
      ? "Gap analysis: identify missing entities/metrics in evidence and create targeted queries for them."
      : "",
    `Return JSON: {\"queries\":[\"...\"]}. Generate ${cap} diverse queries. No URLs, no explanations.`,
  ].filter(Boolean).join("\n");

  const user = [
    `用户问题：\n${String(userQuery ?? "").slice(0, 2400)}`,
    effectiveQuery ? `\n改写查询：\n${String(effectiveQuery).slice(0, 600)}` : "",
    evidence.length
      ? `\n首轮结果（参考）：\n${JSON.stringify(evidence.slice(0, 20))}\n\n请分析缺失的实体或数据，生成针对性补充查询。`
      : "",
  ].filter(Boolean).join("\n");

  try {
    const result = await traceAsync(
      performanceTrace,
      traceName,
      { model: provider.model, maxQueries: cap, evidenceCount: evidence.length },
      () => generateText(provider, {
        signal,
        timeoutMs: Math.min(25_000, Math.max(6_000, Number(process.env.WEB_AI_PLAN_TIMEOUT_MS) || 18_000)),
        // 提高temperature让查询更多样化，二轮搜索时进一步提高
        temperature: evidence.length > 0 ? 0.3 : 0.2,
        maxTokens: 1000,
        system,
        messages: [{ role: "user", content: user }],
      }),
      (value) => ({ status: value?.status, error: value?.error, outputChars: String(value?.text ?? "").length }),
    );
    if (signal?.aborted) throw signal.reason ?? new DOMException("Search cancelled", "AbortError");
    if (!result.ok) return [];
    const queries = parseQueries(result.text, cap);
    if (queries.length > 0) {
      console.log(`[${traceName}] Generated ${queries.length} queries (round ${evidence.length > 0 ? 2 : 1})`);
    }
    return queries;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    console.warn(`[${traceName}] planner unavailable:`, String(error?.message ?? error).slice(0, 160));
    return [];
  }
}
