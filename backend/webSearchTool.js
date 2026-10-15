/**
 * 模型主动联网搜索工具。
 * 复用网页频道的多源检索链路，并对多实体问题做有限拆分和正文抓取。
 */

import { fetchMergedWebPapers, getWebSourcesStatus } from "./mcpWebSearch.js";
import { enrichPapersWithWebPageContent } from "./webPageIngest.js";
import { extractHttpUrls, fetchDirectWebPapers } from "./directWebSearch.js";
import {
  buildEntityCoverageQueries,
  extractRequestedWebEntities,
  markEntityCoverage,
} from "./webSearchAgent.js";
import { clampQueryForExternalApi } from "./searchQueryNormalize.js";
import { filterWebChannelInclusion, buildWebAnswerTokens, scoreWebPaperForAnswer } from "./webRelevance.js";

const DEFAULT_MAX_RESULTS = 12;
const MAX_RESULTS = 32;
const INDUSTRY_RATE_QUERY_RE = /产能利用率|开工率|开工负荷|装置负荷|负荷率/i;
const INDUSTRY_RATE_EVIDENCE_RE = /(?:产能利用率|开工率|开工负荷|装置负荷|负荷率).{0,80}?\d+(?:\.\d+)?\s*(?:%|％)|\d+(?:\.\d+)?\s*(?:%|％).{0,80}?(?:产能利用率|开工率|开工负荷|装置负荷|负荷率)/i;
const INDUSTRY_DATA_DOMAIN_RE = /(?:oilchem\.net|sci99\.com|mysteel\.com|10jqka\.com\.cn|finance\.sina\.com\.cn|lzqh\.net\.cn|100ppi\.com|stats\.gov\.cn|miit\.gov\.cn|customs\.gov\.cn|mei\.net\.cn|caam\.org\.cn|chinaisa\.org\.cn|chinania\.org\.cn)/i;

export const WEB_SEARCH_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "在互联网上检索实时信息。工具会自动并行调用已配置的多路网页搜索源；当问题包含多个产品、公司或指标时，会拆成多条定向查询并抓取部分网页正文。适用于产能利用率、开工率、价格、行业统计、新闻和报告等问题。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "具体查询词，包含实体、指标和时间。例如：MTBE 2026 产能利用率 开工率，或 苯乙烯 2026 隆众资讯 开工率。",
        },
        max_results: {
          type: "number",
          description: "返回结果数量，默认12，范围1-32。",
          default: DEFAULT_MAX_RESULTS,
        },
        search_type: {
          type: "string",
          enum: ["general", "news", "data"],
          description: "搜索类型：general通用，news新闻，data数据/报告。默认general。",
          default: "general",
        },
      },
      required: ["query"],
    },
  },
};

export const WEB_OPEN_URL_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "web_open_url",
    description:
      "读取一个或多个已经找到的网页/PDF URL，返回页面正文和其中的指标数值证据。适合搜索结果只有链接或摘要不足时使用。只能读取公开 http/https 地址。",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "要打开的公开网页或 PDF URL，最多5个。",
          maxItems: 5,
        },
        url: {
          type: "string",
          description: "单个公开网页或 PDF URL；也可以使用 urls 数组。",
        },
      },
      required: [],
    },
  },
};

function uniqueQueries(query, searchType, maxQueries) {
  const suffix = searchType === "news" ? " 最新 新闻" : searchType === "data" ? " 数据 报告" : "";
  const base = clampQueryForExternalApi(`${query}${suffix}`.trim(), 380);
  const entities = extractRequestedWebEntities(query);
  const planned = entities.length >= 4
    ? buildEntityCoverageQueries(query, Math.min(maxQueries - 1, entities.length + 6))
    : [];
  const out = [];
  const seen = new Set();
  for (const item of [base, ...planned]) {
    const value = clampQueryForExternalApi(String(item ?? "").trim(), 380);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= maxQueries) break;
  }
  return out.length ? out : [query.slice(0, 380)];
}

export function buildWebSearchQueries(query, searchType = "general", maxQueries = 3) {
  const searchQuery = queryWithoutUrls(query);
  if (searchQuery.length < 5) return [];
  return uniqueQueries(searchQuery, searchType, maxQueries);
}

function queryWithoutUrls(query) {
  return String(query ?? "")
    .replace(/https?:\/\/[^\s<>\]})"'，。、；！？]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeByUrl(papers) {
  const seen = new Map();
  const out = [];
  for (const paper of papers) {
    const url = String(paper?.absUrl ?? paper?.url ?? "").trim().split("#")[0].toLowerCase();
    if (!url) continue;
    const previous = seen.get(url);
    if (previous) {
      previous._searchedQueries = [...new Set([
        ...(Array.isArray(previous._searchedQueries) ? previous._searchedQueries : []),
        ...(Array.isArray(paper?._searchedQueries) ? paper._searchedQueries : []),
      ])];
      continue;
    }
    const row = {
      ...paper,
      _searchedQueries: Array.isArray(paper?._searchedQueries) ? [...paper._searchedQueries] : [],
    };
    seen.set(url, row);
    out.push(row);
  }
  return out;
}

function rankWebSearchCandidates(papers, answerTokens, query) {
  return [...papers].sort((a, b) => {
    const score = (paper) => {
      const base = scoreWebPaperForAnswer(paper, answerTokens, query, query);
      const queryEvidence = (Array.isArray(paper?._searchedQueries) ? paper._searchedQueries : [])
        .map((searchedQuery) => scoreWebPaperForAnswer(
          paper,
          buildWebAnswerTokens(searchedQuery),
          searchedQuery,
          searchedQuery,
        ))
        .reduce((best, current) => Math.max(best, current), 0);
      return base + queryEvidence * 0.65;
    };
    return score(b) - score(a);
  });
}

function matchesSiteRestrictedQuery(paper, query) {
  const match = String(query ?? "").match(/\bsite:([a-z0-9.-]+)/i);
  if (!match) return true;
  const domain = match[1].toLowerCase().replace(/^www\./, "");
  try {
    const hostname = new URL(String(paper?.absUrl ?? paper?.url ?? "")).hostname.toLowerCase().replace(/^www\./, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function hasIndustryRateEvidence(paper) {
  const text = [
    paper?.title,
    paper?.summary,
    paper?.abstract,
    ...(Array.isArray(paper?.webEvidence) ? paper.webEvidence : []),
  ].filter(Boolean).join(" ");
  return INDUSTRY_RATE_EVIDENCE_RE.test(text);
}

function isTrustedIndustryDataPage(paper) {
  return INDUSTRY_DATA_DOMAIN_RE.test(`${paper?.absUrl ?? paper?.url ?? ""} ${paper?.title ?? ""}`);
}

async function runToolQueriesBounded(queries, perQuery, concurrency = 3) {
  const results = new Array(queries.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= queries.length) return;
      const q = queries[index];
      try {
        results[index] = { status: "fulfilled", value: await fetchMergedWebPapers(q, perQuery, {
          chineseQuery: q,
          tracePrefix: `tool.web_search.query_${index + 1}`,
        }) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queries.length) }, () => worker()));
  return results;
}

export async function executeWebSearchTool(args) {
  const query = String(args?.query ?? "").trim();
  if (!query) return { success: false, error: "查询不能为空", results: [] };

  const maxResults = Math.min(MAX_RESULTS, Math.max(1, Number(args?.max_results) || DEFAULT_MAX_RESULTS));
  const searchType = ["general", "news", "data"].includes(String(args?.search_type))
    ? String(args.search_type)
    : "general";
  const directUrls = extractHttpUrls(query, Math.min(32, Number(process.env.WEB_DIRECT_URL_MAX) || 24));
  const searchQuery = queryWithoutUrls(query);
  const queryCap = Math.min(
    24,
    Math.max(
      1,
      Number(process.env.WEB_TOOL_QUERY_MAX) ||
        (extractRequestedWebEntities(searchQuery).length >= 4
          ? extractRequestedWebEntities(searchQuery).length + 6
          : 3),
    ),
  );
  const all = [];
  const sourceNotes = [];
  const queryDiagnostics = [];
  let directSuccesses = 0;
  let directFailures = [];
  let pageFetch = { fetched: 0, attempted: 0, skipped: 0, errors: 0 };
  if (directUrls.length) {
    const direct = await fetchDirectWebPapers(directUrls, {
      timeoutMs: Number(process.env.WEB_DIRECT_URL_TIMEOUT_MS) || 18_000,
      concurrency: Number(process.env.WEB_DIRECT_URL_CONCURRENCY) || 3,
    });
    all.push(...direct.papers);
    directSuccesses = direct.papers.length;
    directFailures = direct.failures;
    sourceNotes.push(`direct_urls:${direct.papers.length}/${directUrls.length}`);
  }

  const queries = buildWebSearchQueries(query, searchType, queryCap);
  const perQuery = Math.min(36, Math.max(10, Math.ceil((maxResults * 2) / Math.max(1, queries.length))));
  console.log(`[tool.web_search] query="${query.slice(0, 120)}" queries=${queries.length} directUrls=${directUrls.length} max=${maxResults}`);
  const settled = queries.length
    ? await runToolQueriesBounded(queries, perQuery, Number(process.env.WEB_TOOL_QUERY_CONCURRENCY) || 3)
    : [];
  for (const [queryIndex, item] of settled.entries()) {
    if (item.status !== "fulfilled") {
      queryDiagnostics.push({ ok: false, error: String(item.reason?.message || item.reason || "query_failed").slice(0, 160) });
      continue;
    }
    const rows = Array.isArray(item.value?.papers) ? item.value.papers : [];
    const searchedQuery = queries[queryIndex] || "";
    const acceptedRows = rows.filter((paper) => matchesSiteRestrictedQuery(paper, searchedQuery));
    all.push(...acceptedRows
      .map((paper) => ({ ...paper, _searchedQueries: [searchedQuery] })));
    if (item.value?.note) sourceNotes.push(item.value.note);
    queryDiagnostics.push({
      ok: true,
      count: acceptedRows.length,
      rawCount: rows.length,
      siteRejected: rows.length - acceptedRows.length,
      note: String(item.value?.note || "").slice(0, 500),
    });
  }

  const answerTokens = buildWebAnswerTokens(query);
  let papers = rankWebSearchCandidates(
    dedupeByUrl(markEntityCoverage(all, query)),
    answerTokens,
    query,
  );
  if (papers.length) {
    const enriched = await enrichPapersWithWebPageContent(papers, {
      maxPages: Math.min(12, Math.max(6, Math.ceil(maxResults))),
      forceFetchAll: false,
      concurrency: 4,
    }).catch(() => null);
    if (enriched) {
      pageFetch = {
        fetched: Number(enriched.fetched) || 0,
        attempted: Number(enriched.attempted) || 0,
        skipped: Number(enriched.skipped) || 0,
        errors: Number(enriched.errors) || 0,
      };
      if (enriched.papers?.length) papers = enriched.papers;
    }
  }

  const directPapers = papers.filter((paper) => paper?.source === "direct_web");
  const searchPapers = papers.filter((paper) => paper?.source !== "direct_web");
  const inclusion = filterWebChannelInclusion(searchPapers, query, "", Math.max(maxResults, 24));
  papers = [...directPapers, ...(inclusion.papers?.length ? inclusion.papers : searchPapers)];
  const requiresIndustryEvidence = INDUSTRY_RATE_QUERY_RE.test(query);
  if (requiresIndustryEvidence) {
    // For exact operating-rate questions, keep pages with an actual rate/value
    // pair or a known industry data publisher. This prevents chemical
    // definitions and product catalogs from being presented as useful sources.
    papers = papers.filter((paper) =>
      paper?.source === "direct_web" || hasIndustryRateEvidence(paper) || isTrustedIndustryDataPage(paper));
  }
  papers = rankWebSearchCandidates(papers, answerTokens, query);

  const results = papers.slice(0, maxResults).map((paper, index) => ({
    index: index + 1,
    title: String(paper?.title ?? "").slice(0, 240),
    url: String(paper?.absUrl ?? paper?.url ?? ""),
    snippet: String(paper?.summary ?? paper?.abstract ?? "").replace(/\s+/g, " ").slice(0, 1200),
    source: String(paper?.webProviderLabel ?? paper?.venue ?? paper?.source ?? "web"),
    fetched: String(paper?.webFetchNote ?? "").startsWith("fetched"),
    matched_entities: Array.isArray(paper?._matchedEntities) ? paper._matchedEntities : [],
  }));

  const diagnostics = {
    queryCount: queries.length,
    queriesWithResults: queryDiagnostics.filter((item) => item.count > 0).length,
    queryErrors: queryDiagnostics.filter((item) => !item.ok).length,
    rawCandidates: all.length,
    returnedCandidates: results.length,
    relevanceDropped: Number(inclusion.dropped) || 0,
    pageFetch,
    directUrls: { attempted: directUrls.length, fetched: directSuccesses, failures: directFailures.slice(0, 12) },
    sourceStatus: getWebSourcesStatus(),
    perQuery: queryDiagnostics.slice(0, 24),
  };
  console.log(`[tool.web_search] returned=${results.length} candidates=${all.length} fetched=${pageFetch.fetched}/${pageFetch.attempted} sourceNotes=${sourceNotes.length}`);

  return {
    success: true,
    status: results.length ? "results" : "no_results",
    query,
    queries,
    count: results.length,
    sources: [...new Set(sourceNotes)].slice(0, 12),
    diagnostics,
    results,
  };
}

/**
 * 直接读取搜索结果中的 URL。这个工具与 SERP 搜索分开，
 * 让模型可以先搜索，再针对最可能包含数字的页面打开正文。
 */
export async function executeWebOpenUrlTool(args) {
  const raw = [
    ...(Array.isArray(args?.urls) ? args.urls : []),
    ...(args?.url ? [args.url] : []),
  ].join("\n");
  const urls = extractHttpUrls(raw, 5);
  if (!urls.length) return { success: false, error: "没有可读取的公开 URL", results: [] };
  const fetched = await fetchDirectWebPapers(urls, {
    timeoutMs: Number(process.env.WEB_DIRECT_URL_TIMEOUT_MS) || 18_000,
    concurrency: Math.min(3, Number(process.env.WEB_DIRECT_URL_CONCURRENCY) || 3),
  });
  const results = fetched.papers.map((paper, index) => ({
    index: index + 1,
    url: String(paper?.absUrl ?? urls[index] ?? ""),
    title: String(paper?.title ?? "").slice(0, 240),
    content: String(paper?.summary ?? paper?.abstract ?? "").slice(0, 16_000),
    evidence: Array.isArray(paper?.webEvidence) ? paper.webEvidence : [],
  }));
  const failures = fetched.failures.map((item) => ({
    url: String(item?.url ?? ""),
    error: String(item?.error ?? "fetch_failed").slice(0, 240),
  }));
  return {
    success: results.length > 0,
    count: results.length,
    results,
    failures,
  };
}

export function formatWebSearchResult(result) {
  if (!result?.success) return `搜索失败：${result?.error || "未知错误"}`;
  if (!result.results?.length) {
    const d = result.diagnostics;
    const sources = d?.sourceStatus
      ? Object.entries(d.sourceStatus).filter(([, enabled]) => enabled).map(([name]) => name).join("、")
      : "未知";
    return `未找到“${result.query}”的相关网页结果。已执行 ${d?.queryCount || 0} 条查询（${d?.queriesWithResults || 0} 条有候选），配置标记启用的源：${sources || "无"}；正文抓取 ${d?.pageFetch?.fetched || 0}/${d?.pageFetch?.attempted || 0}。搜索源实际诊断：${(result.sources || []).join("；") || "无"}`;
  }
  let text = `搜索“${result.query}”共找到 ${result.count} 条结果`;
  if (result.queries?.length > 1) text += `（自动拆分 ${result.queries.length} 条查询）`;
  const diagnostics = result.diagnostics;
  if (diagnostics) {
    text += `；其中 ${diagnostics.queriesWithResults}/${diagnostics.queryCount} 条查询有结果，正文抓取 ${diagnostics.pageFetch?.fetched || 0}/${diagnostics.pageFetch?.attempted || 0} 成功`;
    if (diagnostics.queryErrors || diagnostics.pageFetch?.errors || diagnostics.directUrls?.failures?.length) {
      text += `，查询失败 ${diagnostics.queryErrors || 0} 条、正文抓取失败 ${diagnostics.pageFetch?.errors || 0} 条`;
    }
    const available = Object.entries(diagnostics.sourceStatus || {})
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    if (available.length) text += `；配置标记启用源：${available.join("、")}`;
  }
  text += "：\n\n";
  for (const item of result.results) {
    text += `[${item.index}] ${item.title}\nURL: ${item.url}\n来源: ${item.source}${item.fetched ? "（已抓取正文）" : ""}\n`;
    if (item.matched_entities?.length) text += `命中实体: ${item.matched_entities.join("、")}\n`;
    text += `摘录: ${item.snippet}\n\n`;
  }
  if (diagnostics?.directUrls?.failures?.length) {
    text += "\n用户指定 URL 读取失败：\n";
    for (const failure of diagnostics.directUrls.failures) text += `- ${failure.url}：${failure.error}\n`;
  }
  return text;
}

export function formatWebOpenUrlResult(result) {
  if (!result?.success && !result?.failures?.length) return `读取网页失败：${result?.error || "未知错误"}`;
  let text = `读取网页 ${result?.count || 0} 个`;
  for (const item of result?.results ?? []) {
    text += `\n\n[${item.index}] ${item.title}\nURL: ${item.url}\n`;
    if (item.evidence?.length) text += `数值证据：${item.evidence.join("；")}\n`;
    text += `正文：${item.content}`;
  }
  if (result?.failures?.length) {
    text += "\n\n无法读取的 URL：";
    for (const item of result.failures) text += `\n- ${item.url}：${item.error}`;
  }
  return text;
}

export async function handleToolCall(toolCall) {
  const functionName = toolCall?.function?.name;
  if (functionName === "web_open_url") {
    let args;
    try {
      args = typeof toolCall?.function?.arguments === "string"
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
    } catch (error) {
      return `错误：无法解析工具参数 - ${error.message}`;
    }
    return formatWebOpenUrlResult(await executeWebOpenUrlTool(args));
  }
  if (functionName !== "web_search") return `错误：未知的工具“${functionName}”`;
  let args;
  try {
    args = typeof toolCall?.function?.arguments === "string"
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function.arguments;
  } catch (error) {
    return `错误：无法解析工具参数 - ${error.message}`;
  }
  return formatWebSearchResult(await executeWebSearchTool(args));
}
