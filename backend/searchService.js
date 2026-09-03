import { upsertPapers, searchLocalPapers, searchDoiRecords, searchFullPapers, isPostgres } from "./db.js";
import { enrichPapersWithWebPageContent } from "./webPageIngest.js";
import { buildArxivSearchQuery, fetchArxiv, mapArxivSort } from "./arxiv.js";
import { fetchCrossrefWorkByDoi, fetchCrossrefWorks } from "./crossref.js";
import { extractDoiCandidate } from "./doi.js";
import { rewriteQueryForSearch, chineseTechnicalFallback } from "./rewrite.js";
import {
  extractCoreSearchQuery,
  extractWebSearchQuery,
  extractConversationContext,
  clampQueryForExternalApi,
} from "./searchQueryNormalize.js";
import { fetchMergedWebPapers, fetchPatentPapers, fetchBingWebSearch } from "./mcpWebSearch.js";
import { fetchOpenAlexWorks, fetchOpenAlexPatents } from "./openalex.js";
import { fetchEuropePmcWorks } from "./europePmc.js";
import { fetchScopusWorks } from "./scopusElsevier.js";
import { fetchSemanticScholarWorks, fetchSemanticScholarByDoi } from "./semanticScholar.js";
import { strictRecommendFilterAndRank } from "./paperRecommendFilter.js";
import { raceWithTimeout } from "./fetchWithTimeout.js";
import { searchCache, rewriteCache, semanticCache } from "./cache.js";
import {
  understandQuery,
  buildSemanticTokens,
  compactQueryIntent,
  rerankPapersByEmbedding,
  isSemanticUnderstandEnabled,
} from "./semanticUnderstand.js";
import { correctQueryTypos } from "./queryTypoCorrect.js";
import { extractPatentNumberFromPaper } from "./patentNumber.js";
import { buildWebMultiSearchQueries, inferFollowUpWebQueries } from "./webEntitySearch.js";
import { buildBookWebSearchPlan, extractBookTitles, isBookIntentQuery } from "./bookWebClues.js";
import { buildEntityDirectWebSeeds } from "./webEntityDirectSeeds.js";
import { filterWebChannelInclusion, buildWebAnswerTokens, scoreWebPaperForAnswer } from "./webRelevance.js";
import { traceAsync } from "./performanceTrace.js";

/** @param {object} p */
function isPatentSourcePaper(p) {
  const s = String(p?.source ?? "");
  return s === "ddg_patent" || s === "openalex_patent";
}

/** 网页渠道是否同时检索专利（默认 true；WEB_CHANNEL_PATENTS=0 则仅全网网页） */
function isWebChannelPatentsEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.WEB_CHANNEL_PATENTS ?? "1").trim());
}

const WEB_PAGE_SOURCES = new Set([
  "mcp_web",
  "ddg_web",
  "dataify_web",
  "tavily_web",
  "searx_web",
  "qwant_web",
  "mojeek_web",
  "wikipedia_web",
  "core",
  "entity_seed",
]);

/** 网页渠道：可展示的网页条目（必须有 http(s) 链接） */
function isWebPageResultPaper(p) {
  const s = String(p?.source ?? "");
  if (!WEB_PAGE_SOURCES.has(s)) return false;
  return /^https?:\/\//i.test(String(p.absUrl ?? "").trim());
}

/** 网页渠道允许的来源：专利 + 带网址的网页，不含 arXiv/Crossref/Scopus 等论文索引 */
function isWebPatentIntelPaper(p) {
  return isPatentSourcePaper(p) || isWebPageResultPaper(p);
}

/**
 * 网页渠道收尾：剔除论文索引条目；专利补全号；网页无 URL 的丢弃。
 * @param {object[]} papers
 * @param {number} max
 */
/** 网页/专利渠道：合并型号（如 SPU-361）、中文关键词与英文检索式 */
function buildWebPatentSearchQuery(rawQuery, effectiveQuery) {
  const parts = [];
  const eq = String(effectiveQuery ?? "").trim();
  const raw = extractCoreSearchQuery(rawQuery) || String(rawQuery ?? "").trim();
  if (eq) parts.push(eq);
  const codes = raw.match(/\b[A-Z]{2,8}[-_]?\d{2,6}\b/gi) || [];
  for (const c of codes) parts.push(c);
  const zhFb = chineseTechnicalFallback(raw);
  if (zhFb) parts.push(zhFb);
  if (/[\u4e00-\u9fff]/.test(raw) && raw.length <= 120) parts.push(raw);
  const uniq = [...new Set(parts.join(" ").split(/\s+/).filter(Boolean))];
  return clampQueryForExternalApi(uniq.join(" "), 400) || eq || raw.slice(0, 200);
}

function finalizeWebPatentIntelRows(papers, max) {
  const cap = Math.min(120, Math.max(1, Number(max) || 40));
  const arr = Array.isArray(papers) ? papers.filter(isWebPatentIntelPaper) : [];
  const out = [];
  for (const p of arr) {
    if (isPatentSourcePaper(p)) {
      const pn = String(p.patentNumber ?? "").trim() || extractPatentNumberFromPaper(p);
      out.push(pn ? { ...p, patentNumber: pn } : { ...p });
    } else {
      const url = String(p.absUrl ?? "").trim();
      out.push({
        ...p,
        absUrl: url,
        pdfUrl: String(p.pdfUrl ?? url).trim() || url,
      });
    }
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 仅专利模式：只保留专利类条目，并尽量写入 patentNumber（便于列表与导出）。
 * @param {object[]} papers
 * @param {number} max
 */
function finalizePatentsOnlyRows(papers, max) {
  const cap = Math.min(200, Math.max(1, Number(max) || 40));
  const arr = Array.isArray(papers) ? papers.filter(isPatentSourcePaper) : [];
  const out = [];
  for (const p of arr) {
    const pn = String(p.patentNumber ?? "").trim() || extractPatentNumberFromPaper(p);
    out.push(pn ? { ...p, patentNumber: pn } : { ...p });
    if (out.length >= cap) break;
  }
  return out;
}

function normTitle(t) {
  return String(t ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
    .trim()
    .slice(0, 160);
}

function dedupeKey(p) {
  const doi = String(p.doi ?? "").trim().toLowerCase();
  if (doi) return `doi:${doi}`;
  if (
    (p.source === "mcp_web" ||
      p.source === "dataify_web" ||
      p.source === "ddg_web" ||
      p.source === "searx_web" ||
      p.source === "qwant_web" ||
      p.source === "mojeek_web" ||
      p.source === "wikipedia_web" ||
      p.source === "core" ||
      p.source === "ddg_patent" ||
      p.source === "openalex_patent") &&
    p.absUrl
  ) {
    return `url:${String(p.absUrl).split("#")[0].toLowerCase()}`;
  }
  const auth = (p.authors ?? []).join(",").toLowerCase().replace(/\s+/g, " ").slice(0, 100);
  return `t:${normTitle(p.title)}|a:${auth}|y:${p.year ?? ""}`;
}

function scoreSource(x) {
  if (String(x?.pdfUrl ?? "").startsWith("db-pdf:")) return 100;
  if (x.source === "local") return 3;
  /** 爱思唯尔 Scopus：合并去重时优先保留该来源的题录与摘要 */
  if (x.source === "scopus") return 10;
  if (x.source === "arxiv") return 2;
  if (x.source === "dataify_web") return 2.22;
  if (x.source === "tavily_web") return 2.24;
  if (x.source === "core") return 2.28;
  if (x.source === "wikipedia_web") return 2.05;
  if (x.source === "searx_web") return 2.18;
  if (x.source === "mcp_web") return 2.15;
  if (x.source === "qwant_web") return 2.12;
  if (x.source === "ddg_web") return 2.1;
  if (x.source === "mojeek_web") return 2.08;
  if (x.source === "ddg_patent") return 2.2;
  if (x.source === "openalex") return 1.05;
  /** OpenAlex 专利索引 */
  if (x.source === "openalex_patent") return 1.35;
  /** Europe PMC 生物医学等开放检索 */
  if (x.source === "europepmc") return 1.55;
  if (x.source === "semantic_scholar") return 1.8; // Semantic Scholar 优先级较高
  return 1;
}

/** 从用户问题抽取英文/化学式类 token，用于剔除与问题词**零交集**的跑题结果 */
function extractQueryTokens(raw) {
  const m = String(raw ?? "").match(/[A-Za-z\u00C0-\u024f][A-Za-z0-9+\-]{2,}/g);
  if (!m?.length) return [];
  const noise = new Set([
    "the",
    "and",
    "for",
    "are",
    "was",
    "has",
    "not",
    "can",
    "use",
    "may",
    "new",
    "all",
    "any",
    "with",
    "from",
    "this",
    "that",
    "into",
  ]);
  const seen = new Set();
  const out = [];
  for (const w of m) {
    const k = w.toLowerCase();
    if (k.length < 3 || noise.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= 22) break;
  }
  return out;
}

function countTokenHits(paper, tokens) {
  const raw = `${paper.title || ""} ${paper.summary || paper.abstract || ""}`;
  const blob = raw.toLowerCase();
  let n = 0;
  for (const t of tokens) {
    const s = String(t);
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (raw.includes(s)) n++;
    } else {
      const tl = s.toLowerCase();
      if (tl.length >= 2 && blob.includes(tl)) n++;
    }
  }
  return n;
}

/** 用户问题中的中文短语，用于与题录/摘要匹配 */
function extractChinesePhrases(raw) {
  const m = String(raw ?? "").match(/[\u4e00-\u9fff]{2,12}/g);
  if (!m?.length) return [];
  const seen = new Set();
  const out = [];
  for (const w of m) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 14) break;
  }
  return out;
}

/** 用户喜好 / 侧栏收藏关键词（字符串数组），并入相关性 token */
function normalizePreferenceKeywords(preferenceKeywords) {
  if (!Array.isArray(preferenceKeywords)) return [];
  const seen = new Set();
  const out = [];
  for (const item of preferenceKeywords) {
    const s = String(item ?? "").trim().slice(0, 96);
    if (!s) continue;
    for (const w of [...extractQueryTokens(s), ...extractChinesePhrases(s)]) {
      const k = /[\u4e00-\u9fff]/.test(w) ? w : w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(w);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** 合并用户原文、LLM 英文检索词与喜好词（纯中文问题时仅靠 raw 抽不到词，噪声无法剔除） */
function extractQueryTokensMerged(rawQuery, effectiveQuery, preferenceKeywords) {
  const seen = new Set();
  const out = [];
  const sources = [
    ...extractQueryTokens(rawQuery),
    ...extractQueryTokens(effectiveQuery),
    ...extractChinesePhrases(rawQuery),
    ...normalizePreferenceKeywords(preferenceKeywords),
  ];
  for (const w of sources) {
    const k = /[\u4e00-\u9fff]/.test(w) ? w : w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * 若至少两条文献命中用户问题里的专业词，且存在 ≥3 条完全零命中，则丢掉零命中条目（缓解 arXiv/Crossref 噪声）。
 * 修改：放宽条件，确保不会过滤掉太多结果
 */
function dropZeroRelevanceByTokens(papers, rawQuery, effectiveQuery, preferenceKeywords) {
  const tokens = extractQueryTokensMerged(rawQuery, effectiveQuery, preferenceKeywords);
  const hasEnglishToken = tokens.some((t) => /[a-zA-Z]{2,}/i.test(String(t)));
  const isChineseOnly =
    /[\u4e00-\u9fff]/.test(String(rawQuery ?? "")) &&
    !hasEnglishToken &&
    !/[a-zA-Z]{2,}/i.test(String(effectiveQuery ?? ""));
  const isWebSrc = (p) => WEB_PAGE_SOURCES.has(String(p?.source ?? ""));
  if (isChineseOnly && papers.every((p) => !isWebSrc(p))) return papers;
  if (tokens.length < 2 || papers.length <= 12) return papers;
  const scored = papers.map((p) => ({ p, c: countTokenHits(p, tokens) }));
  const isPatentSrc = (p) => {
    const s = String(p?.source ?? "");
    return s === "ddg_patent" || s === "openalex_patent";
  };
  const withHits = scored.filter((x) => x.c > 0 || isPatentSrc(x.p));
  const withoutHits = scored.filter((x) => x.c === 0 && !isPatentSrc(x.p));
  if (withHits.length < 3) return papers;
  if (withoutHits.length < 2) return papers;
  if (withHits.length < papers.length * 0.35) return papers;
  return withHits.map((x) => x.p);
}

export function mergeDedupe(lists) {
  const map = new Map();
  const exactTitleKeys = new Map();
  for (const list of lists) {
    for (const p of list) {
      const normalizedTitle = normTitle(p.title);
      const titleAlias = normalizedTitle.length >= 32 ? exactTitleKeys.get(normalizedTitle) : null;
      const k = titleAlias || dedupeKey(p);
      const prev = map.get(k);
      if (!prev) {
        map.set(k, p);
        if (normalizedTitle.length >= 32) exactTitleKeys.set(normalizedTitle, k);
        continue;
      }
      if (scoreSource(p) >= scoreSource(prev)) {
        const merged = {
          ...prev,
          ...p,
          authors: p.authors?.length ? p.authors : prev.authors,
          summary: (p.summary || p.abstract || "").length >= (prev.summary || "").length ? p.summary || p.abstract : prev.summary,
        };
        const databasePdfUrl = [prev.pdfUrl, p.pdfUrl]
          .map((value) => String(value ?? "").trim())
          .find((value) => value.startsWith("db-pdf:"));
        if (databasePdfUrl) {
          const databasePaper = [prev, p].find(
            (candidate) => String(candidate?.pdfUrl ?? "").trim() === databasePdfUrl,
          );
          merged.pdfUrl = databasePdfUrl;
          merged.paper_id = databasePaper?.paper_id ?? merged.paper_id;
          merged.id = databasePaper?.id ?? databasePaper?.paper_id ?? merged.id;
          merged.source = databasePaper?.source ?? "local";
        }
        map.set(k, merged);
      }
      if (normalizedTitle.length >= 32) exactTitleKeys.set(normalizedTitle, k);
    }
  }
  return [...map.values()];
}

function rowToApiPaper(row) {
  let authors = [];
  try {
    // 兼容 authors_json（原始列名）和 authors（searchLocalPapers 别名）
    authors = JSON.parse(row.authors_json || row.authors || "[]");
  } catch {
    authors = [];
  }
  const arxivId = row.arxiv_id || String(row.paper_id || "").replace(/^arxiv:/, "") || row.paper_id;
  // 兼容 abstract（原始列名）和 summary（searchLocalPapers 别名）
  const abstract = row.abstract || row.summary || "";
  const pid = String(row.paper_id ?? "").trim();
  const venue = String(row.venue ?? row.journal ?? "").trim();
  const isPatent =
    pid.startsWith("openalex_patent:") ||
    pid.startsWith("ddg_patent:") ||
    pid.startsWith("local:patent:") ||
    /\bpatent\b/i.test(venue);
  return {
    paper_id: row.paper_id,
    doi: row.doi,
    title: row.title,
    summary: abstract,
    abstract: abstract,
    year: row.year,
    venue: venue,
    published: row.year ? `${row.year}-01-01` : "",
    authors,
    id: arxivId,
    absUrl: row.abs_url,
    pdfUrl: row.pdf_url,
    source: isPatent ? "openalex_patent" : "local",
    oa_status: row.oa_status,
    isReferencedByCount: null,
    patentNumber: isPatent ? (row.patentNumber || row.patent_number || extractPatentNoFromVenueUrl(venue, row.abs_url)) : undefined,
  };
}

function extractPatentNoFromVenueUrl(venue, absUrl) {
  const blob = `${venue} ${absUrl || ""}`;
  const m = blob.match(/\b(?:US|EP|WO|CN|JP|KR|DE|FR|GB|TW|IN)\s*[-_]?\s*\d[\d,\s]{4,}\s*[A-Z0-9]?\b/i);
  return m ? m[0].replace(/[\s,]+/g, "").slice(0, 48) : "";
}

function toIngestRows(papers) {
  const now = Date.now();
  return papers.map((p) => ({
    paper_id: p.paper_id,
    doi: p.doi,
    title: p.title,
    abstract: p.abstract ?? p.summary ?? "",
    year: p.year,
    venue: p.venue,
    oa_status: p.oa_status,
    arxiv_id: p.arxiv_id ?? null,
    authors_json: JSON.stringify(p.authors ?? []),
    abs_url: p.absUrl,
    pdf_url: p.pdfUrl,
    patentNumber: p.patentNumber ?? null,
    created_at: now,
  }));
}

/**
 * 将 material_kb 数据库的 papers 表行转换为 API 格式
 * @param {Object} row
 * @returns {Object}
 */
function materialKbRowToApiPaper(row) {
  let authors = [];
  try {
    authors = JSON.parse(row.authors_json || row.authors || "[]");
  } catch {
    authors = row.authors ? row.authors.split(",").map(a => a.trim()) : [];
  }
  return {
    paper_id: row.paper_id || row.id || row.doi,
    doi: row.doi,
    title: row.title,
    summary: row.abstract || "",
    abstract: row.abstract || "",
    year: row.year,
    venue: row.journal || row.venue,
    published: row.year ? `${row.year}-01-01` : "",
    authors,
    id: row.doi || row.paper_id,
    absUrl: row.url || row.abs_url,
    pdfUrl: row.pdf_url,
    source: "local",
    oa_status: row.oa_status,
    isReferencedByCount: row.citation_count || null,
    // 材料科学11个要素
    category: row.category,
    material_name: row.material_name,
    symmetry_phase: row.symmetry_phase,
    structure_descriptor: row.structure_descriptor,
    properties: row.properties,
    applications: row.applications,
    synthesis_method: row.synthesis_method,
    characterization_method: row.characterization_method,
    quality_control: row.quality_control,
    first_author: row.first_author,
    corresponding_author: row.corresponding_author,
    relevance_score: row.relevance_score,
    credibility_score: row.credibility_score,
  };
}

/**
 * 将 doi_records 表行转换为 API 格式
 * @param {Object} row
 * @returns {Object}
 */
function doiRecordToApiPaper(row) {
  let authors = [];
  try {
    authors = JSON.parse(row.authors || "[]");
  } catch {
    authors = row.authors ? row.authors.split(",").map(a => a.trim()) : [];
  }
  // 确保 title 也复制到 summary/abstract，以便 token 匹配能正常工作
  const title = row.title || "";
  return {
    paper_id: `doi:${row.doi}`,
    doi: row.doi,
    title: title,
    summary: title,  // 复制标题到 summary，确保 countTokenHits 能匹配
    abstract: title, // 复制标题到 abstract，确保 countTokenHits 能匹配
    year: row.year,
    venue: row.journal,
    published: row.publish_date || (row.year ? `${row.year}-01-01` : ""),
    authors,
    id: row.doi,
    absUrl: row.url,
    pdfUrl: null,
    source: "local",
    oa_status: null,
    isReferencedByCount: null,
  };
}

function timeMs(p) {
  const d = Date.parse(p.published || "");
  return Number.isFinite(d) ? d : 0;
}

function applySort(merged, sort) {
  const out = [...merged];
  if (sort === "relevance") return out;
  if (sort === "citations") {
    out.sort(
      (a, b) =>
        (b.isReferencedByCount || 0) - (a.isReferencedByCount || 0) ||
        String(a.paper_id).localeCompare(String(b.paper_id)),
    );
    return out;
  }
  if (sort === "submittedDate" || sort === "lastUpdatedDate") {
    out.sort(
      (a, b) => timeMs(b) - timeMs(a) || String(a.paper_id).localeCompare(String(b.paper_id)),
    );
    return out;
  }
  out.sort((a, b) => String(a.paper_id).localeCompare(String(b.paper_id)));
  return out;
}

/**
 * 全网多路检索（多 query 并行 + 二轮跟进 + 实体种子），网页渠道与数据库渠道的网页补充共用。
 * @param {{ fullRawQuery: string; rawQuery: string; effectiveQuery: string; max: number; useMcpWeb?: boolean; includePatents?: boolean }} opts
 * @returns {Promise<{ papers: object[]; patents: object[]; sourcesUsed: string[] }>}
 */
async function runWebIntelSearch(opts) {
  const fullRawQuery = String(opts.fullRawQuery ?? "").trim();
  const rawQuery = String(opts.rawQuery ?? "").trim();
  const effectiveQuery = String(opts.effectiveQuery ?? "").trim();
  const max = Math.max(1, Number(opts.max) || 80);
  const useMcpWeb = opts.useMcpWeb !== false;
  const includePatents = opts.includePatents !== false && isWebChannelPatentsEnabled();
  const sourcesUsed = [];
  const performanceTrace = opts.performanceTrace;

  if (!useMcpWeb) {
    sourcesUsed.push("web_intel_skipped_mcp");
    return { papers: [], patents: [], sourcesUsed };
  }

  const webSearchQ = extractWebSearchQuery(fullRawQuery) || rawQuery;
  const webPlan = buildWebMultiSearchQueries(
    webSearchQ,
    effectiveQuery,
    extractConversationContext(fullRawQuery),
  );
  const webPrimary = webPlan.primary || webSearchQ;
  if (webPlan.tags.length) sourcesUsed.push(...webPlan.tags);
  if (webPlan.queries.length > 1) sourcesUsed.push(`web_multi_query:${webPlan.queries.length}`);

  let patentSearch = [];
  const webPaperBuckets = [];
  const webTasks = [];
  const perWebQ = Math.min(64, max + 32);
  const webQueryCap = Math.min(12, Math.max(4, Number(process.env.WEB_MULTI_QUERY_MAX) || 8));

  if (includePatents) {
    webTasks.push({
      name: "openalex_patents",
      promise: traceAsync(
        performanceTrace,
        "search.web.round1.openalex_patents",
        {},
        () => fetchOpenAlexPatents(webSearchQ, 45),
        (rows) => ({ results: Array.isArray(rows) ? rows.length : 0 }),
      ),
    });
    webTasks.push({
      name: "patents",
      promise: traceAsync(
        performanceTrace,
        "search.web.round1.patents",
        {},
        () => fetchPatentPapers(webPrimary, 45),
        (value) => ({ results: Array.isArray(value?.papers) ? value.papers.length : 0 }),
      ),
    });
  }

  webPlan.queries.slice(0, webQueryCap).forEach((q, i) => {
    webTasks.push({
      name: `web_merge_q${i}`,
      promise: traceAsync(
        performanceTrace,
        `search.web.round1.query_${i + 1}`,
        { queryChars: q.length },
        () => fetchMergedWebPapers(q, perWebQ, {
          chineseQuery: webSearchQ,
          performanceTrace,
          tracePrefix: `search.web.round1.query_${i + 1}.source`,
        }),
        (value) => ({ results: Array.isArray(value?.papers) ? value.papers.length : 0, tool: value?.toolName }),
      ),
    });
  });

  const webLayer = await traceAsync(
    performanceTrace,
    "search.web.round1.wait",
    { tasks: webTasks.length },
    () => raceWithTimeout(
      webTasks,
      Math.min(90_000, Math.max(45_000, Number(process.env.WEB_SEARCH_LAYER_TIMEOUT_MS) || 70_000)),
    ),
    (rows) => ({ fulfilled: rows.filter((x) => x.status === "fulfilled").length }),
  );
  for (const r of webLayer) {
    if (r.status !== "fulfilled") {
      console.warn(`[search] ${r.name} timeout/failed:`, r.reason);
      sourcesUsed.push(`${r.name}_error`);
      continue;
    }
    if (r.name === "openalex_patents") {
      const oaPatPapers = Array.isArray(r.value) ? r.value : [];
      if (oaPatPapers.length) {
        patentSearch = patentSearch.concat(oaPatPapers);
        sourcesUsed.push("openalex_patents");
      }
      continue;
    }
    if (r.name === "patents") {
      const ptVal = r.value;
      const patPapers = ptVal && typeof ptVal === "object" ? (ptVal.papers ?? []) : [];
      const arr = Array.isArray(patPapers) ? patPapers : Array.isArray(ptVal) ? ptVal : [];
      if (arr.length) {
        patentSearch = patentSearch.concat(arr);
        const ptTool = ptVal && ptVal.toolName;
        sourcesUsed.push(ptTool ? `patents:${ptTool}` : "patents");
      }
      continue;
    }
    if (r.name.startsWith("web_merge_q")) {
      const wv = r.value;
      const wp = wv?.papers ?? [];
      if (wp.length) {
        webPaperBuckets.push(wp);
        sourcesUsed.push(wv.toolName ? `web:${wv.toolName}(${wp.length})` : `web(${wp.length})`);
      }
    }
  }

  let webMerged = webPaperBuckets.flat();
  /**
   * 第二轮只作为低频兜底：限制查询数和等待预算，避免特殊实体问题把整条请求拖到
   * 首轮超时之后再额外等待 30～40 秒。环境变量仍可把上限调得更保守，但不会突破这里的硬上限。
   */
  const round2QueryCap = Math.min(
    2,
    Math.max(1, Number(process.env.WEB_ROUND2_QUERY_MAX) || 2),
  );
  const followUp = inferFollowUpWebQueries(webMerged, rawQuery).slice(0, round2QueryCap);
  if (followUp.length) {
    sourcesUsed.push(`web_round2:${followUp.length}`);
    const round2Tasks = followUp.map((q, i) => ({
      name: `web_r2_q${i}`,
      promise: traceAsync(
        performanceTrace,
        `search.web.round2.query_${i + 1}`,
        { queryChars: q.length },
        () => fetchMergedWebPapers(q, perWebQ, {
          chineseQuery: webSearchQ,
          performanceTrace,
          tracePrefix: `search.web.round2.query_${i + 1}.source`,
        }),
        (value) => ({ results: Array.isArray(value?.papers) ? value.papers.length : 0, tool: value?.toolName }),
      ),
    }));
    const r2 = await traceAsync(
      performanceTrace,
      "search.web.round2.wait",
      { tasks: round2Tasks.length },
      () => raceWithTimeout(
        round2Tasks,
        Math.min(15_000, Math.max(8_000, Number(process.env.WEB_ROUND2_TIMEOUT_MS) || 12_000)),
      ),
      (rows) => ({ fulfilled: rows.filter((x) => x.status === "fulfilled").length }),
    );
    for (const fr of r2) {
      if (fr.status === "fulfilled" && fr.value?.papers?.length) {
        webMerged = webMerged.concat(fr.value.papers);
      }
    }
  }

  if (isBookIntentQuery(webSearchQ) && webMerged.length < 2) {
    const bp = buildBookWebSearchPlan(webSearchQ, effectiveQuery);
    const rescueQs = bp.queries.length
      ? bp.queries.slice(0, 2)
      : extractBookTitles(webSearchQ).map((t) => `${t} 目录 章节`).slice(0, 2);
    /** 书籍救援并行执行少量最高优先级查询，并设置每轮总等待上限。 */
    const rescueTasks = rescueQs.map((rq, i) => ({
      name: `book_rescue_q${i}`,
      promise: traceAsync(
        performanceTrace,
        `search.web.book_rescue.query_${i + 1}`,
        { queryChars: rq.length },
        () => fetchMergedWebPapers(rq, Math.max(perWebQ, 36), {
          chineseQuery: webSearchQ,
          performanceTrace,
          tracePrefix: `search.web.book_rescue.query_${i + 1}.source`,
        }),
        (value) => ({ results: Array.isArray(value?.papers) ? value.papers.length : 0, tool: value?.toolName }),
      ),
    }));
    const rescueTimeoutMs = Math.min(
      20_000,
      Math.max(8_000, Number(process.env.WEB_BOOK_RESCUE_TIMEOUT_MS) || 15_000),
    );
    const rescueResults = await traceAsync(
      performanceTrace,
      "search.web.book_rescue.wait",
      { tasks: rescueTasks.length, timeoutMs: rescueTimeoutMs },
      () => raceWithTimeout(rescueTasks, rescueTimeoutMs),
      (rows) => ({ fulfilled: rows.filter((x) => x.status === "fulfilled").length }),
    );
    for (const rr of rescueResults) {
      if (webMerged.length >= 8) break;
      if (rr.status === "fulfilled" && rr.value?.papers?.length) {
        webMerged = webMerged.concat(rr.value.papers);
        sourcesUsed.push(rr.value.toolName ? `book_rescue:${rr.value.toolName}` : "book_rescue:web");
      } else if (rr.status !== "fulfilled") {
        console.warn("[search] book_clue rescue failed", rr.name, rr.reason);
      }
    }
    if (rescueQs.length) sourcesUsed.push("book_clue_emergency_fetch");
  }

  const entitySeeds = buildEntityDirectWebSeeds(webSearchQ);
  if (entitySeeds.length) {
    webMerged = entitySeeds.concat(webMerged);
    sourcesUsed.push(`entity_direct_seeds:${entitySeeds.length}`);
  }

  return { papers: webMerged, patents: patentSearch, sourcesUsed };
}

/**
 * @param {object} opts
 * @param {string} opts.rawQuery
 * @param {'database'|'web'} opts.channel
 * @param {boolean} [opts.useMcpWeb] 为 false 时不外呼专利/全网网页补充（默认 true）；文献库与其它源仍照常检索
 * @param {'ti'|'abs'|'all'} opts.field
 * @param {string} opts.sort
 * @param {number} opts.max
 * @param {boolean} [opts.useLlmRewrite]
 * @param {string} [opts.openaiApiKey] 用户请求头传入的 LLM Key（X-OpenAI-Key / X-DeepSeek-Key 等，不在日志中落库）
 * @param {string} [opts.openaiModel] 模型名
 * @param {string} [opts.llmChatCompletionsUrl] 兼容接口完整 URL（…/chat/completions）
 * @param {string} [opts.personaSkill] 用户身份 Skill 全文，先于默认策略参与检索式改写
 * @param {boolean} [opts.patentsOnly] 为 true 时仅外呼专利源（OpenAlex 专利 + DDG/MCP 专利），结果只含专利条目并补全 patentNumber
 */
export async function runPaperSearch(opts) {
  const started = Date.now();
  const channel = opts.channel === "web" ? "web" : "database";
  const useMcpWeb = opts.useMcpWeb !== false;
  const field = opts.field === "ti" || opts.field === "abs" ? opts.field : "all";
  /** 上限：数据库渠道可略大；网页多源外呼略保守 */
  const maxCap =
    channel === "database"
      ? 220
      : Math.min(360, Math.max(120, Number(process.env.WEB_SEARCH_MAX_CAP) || 320));
  /** 条数不固定：网页渠道默认池更大，再由相关度过滤 */
  const defaultMax =
    channel === "database"
      ? 100
      : Math.min(maxCap, Math.max(48, Number(process.env.WEB_SEARCH_DEFAULT_MAX) || 128));
  const max = Math.min(maxCap, Math.max(1, Number(opts.max) || defaultMax));
  const sort = opts.sort || "relevance";
  const useLlm = opts.useLlmRewrite !== false;
  const patentsOnly = opts.patentsOnly === true;
  const performanceTrace = opts.performanceTrace;

  const fullRawQuery = String(opts.rawQuery ?? "").trim();
  const conversationContext = String(opts.conversationContext ?? "").trim().slice(0, 8000);
  const rawQuery = extractCoreSearchQuery(fullRawQuery) || fullRawQuery;
  const fullContextQuery = conversationContext
    ? `${conversationContext}\n\n---- 当前提问 ----\n${rawQuery}`
    : fullRawQuery;
  const coreQueryExtracted =
    rawQuery.length > 0 &&
    (fullContextQuery.length > rawQuery.length + 40 || conversationContext.length > 0);

  const typoFix = correctQueryTypos(rawQuery);
  const queryForSearch = typoFix.hadTypo ? typoFix.corrected : rawQuery;

  // 先处理rewrite，因为effectiveQuery可能影响缓存键
  // 检查rewrite缓存
  const rewriteCacheKey = searchCache.constructor.key('rewrite', {
    q: queryForSearch,
    ctx: conversationContext.slice(0, 120),
    useLlm,
    model: opts.openaiModel,
    personaSkill: opts.personaSkill?.slice(0, 50),
  });
  let rw = rewriteCache.get(rewriteCacheKey);
  const semanticCacheKey = searchCache.constructor.key("semantic", {
    q: queryForSearch,
    personaSkill: opts.personaSkill?.slice(0, 50),
  });
  let queryIntent = semanticCache.get(semanticCacheKey);

  const llmOpts = {
    apiKey: opts.openaiApiKey,
    model: opts.openaiModel,
    chatCompletionsUrl: opts.llmChatCompletionsUrl,
    personaSkill: opts.personaSkill,
  };

  const pending = [];
  if (!rw) {
    pending.push(
      (async () => {
        rw = useLlm
          ? await traceAsync(
              performanceTrace,
              "search.query_rewrite",
              { queryChars: queryForSearch.length },
              () => rewriteQueryForSearch(queryForSearch, { ...llmOpts, conversationContext }),
              (value) => ({ note: value?.note }),
            )
          : { effectiveQuery: queryForSearch, note: "rewrite:skipped" };
        rewriteCache.set(rewriteCacheKey, rw);
      })(),
    );
  } else {
    console.log(`[rewrite] cache hit for "${rawQuery.slice(0, 30)}..."`);
  }
  if (!queryIntent && isSemanticUnderstandEnabled()) {
    pending.push(
      (async () => {
        queryIntent = await traceAsync(
          performanceTrace,
          "search.semantic_understand",
          { queryChars: queryForSearch.length },
          () => understandQuery(queryForSearch, llmOpts),
          (value) => ({ produced: Boolean(value) }),
        );
        if (queryIntent) {
          if (typoFix.hadTypo) {
            queryIntent.typoFixes = [...(queryIntent.typoFixes || []), ...typoFix.fixes];
            queryIntent.correctedQuery = queryForSearch;
          }
          semanticCache.set(semanticCacheKey, queryIntent);
        }
      })(),
    );
  } else if (queryIntent) {
    console.log(`[semantic] cache hit for "${rawQuery.slice(0, 30)}..."`);
    if (typoFix.hadTypo) {
      queryIntent.typoFixes = [...new Set([...(queryIntent.typoFixes || []), ...typoFix.fixes])];
      queryIntent.correctedQuery = queryForSearch;
    }
  }
  if (pending.length) await Promise.all(pending);
  
  // 如果改写结果为空或无效，使用原始查询
  if (typoFix.hadTypo) {
    rw.note = (rw.note || "") + ` · typo:${typoFix.fixes.join(",")}`;
  }
  let effectiveQuery = rw.effectiveQuery || queryForSearch;
  // 检测无效改写结果：空、乱码、中文胡说八道、unrecognized等
  const isInvalidRewrite = !effectiveQuery 
    || effectiveQuery === "??" 
    || effectiveQuery === "unrecognized input"
    || /^(?:鉴于|由于|因为|所以|因此|然而|但是|输入|输出|unrecognized|invalid|error)/i.test(effectiveQuery);
  if (isInvalidRewrite) {
    console.log(`[rewrite] invalid effectiveQuery "${effectiveQuery.slice(0, 50)}", falling back to raw query`);
    effectiveQuery = rawQuery;
    rw.note = (rw.note || "") + " · rewrite:invalid-fallback";
  }
  // 中文查询 + LLM 改写失败（401 等）：用规则英文关键词检索外网，本地库仍可用 rawQuery 搜
  if (/[\u4e00-\u9fff]/.test(rawQuery)) {
    const rewriteFailed = /rewrite:http_|rewrite_error:|rewrite:timeout|stub:no-llm-key/.test(
      String(rw.note ?? ""),
    );
    if (rewriteFailed || !/[a-zA-Z]{3,}/.test(effectiveQuery)) {
      const fb = chineseTechnicalFallback(rawQuery) || chineseTechnicalFallback(effectiveQuery);
      if (fb) {
        effectiveQuery = fb;
        rw.note = (rw.note || "") + " · zh-en-keyword-fallback";
        console.log(`[rewrite] Chinese query → English keywords: ${fb.slice(0, 80)}`);
      } else if (!/[a-zA-Z]{3,}/.test(effectiveQuery)) {
        effectiveQuery = rawQuery;
        rw.note = (rw.note || "") + " · rewrite:chinese-raw-no-fb";
      }
    } else if (!/[\u4e00-\u9fff]/.test(effectiveQuery) && effectiveQuery !== rawQuery) {
      /* LLM 已给出英文检索式，保留 */
    }
  }

  effectiveQuery = clampQueryForExternalApi(effectiveQuery, 400);
  
  // 检查搜索结果缓存 - 使用原始查询+effectiveQuery作为缓存键
  const cacheKey = searchCache.constructor.key('search', {
    q: rawQuery,
    eq: effectiveQuery, // 包含改写后的查询，避免改写变化时返回旧缓存
    channel,
    max,
    sort,
    field,
    po: patentsOnly ? 1 : 0,
    wi: channel === "web" && !patentsOnly ? 1 : 0,
    personaSkill: opts.personaSkill?.slice(0, 30),
  });
  const cached = searchCache.get(cacheKey);
  if (cached && cached.papers?.length >= 12) { // 只有结果>=12篇才用缓存，太少说明上次搜索失败需重试
    console.log(`[search] cache hit for "${rawQuery.slice(0, 30)}..." (${cached.papers.length} papers)`);
    return {
      ...cached,
      latencyMs: Date.now() - started,
      fromCache: true,
    };
  }
  if (cached && cached.papers?.length > 0) {
    console.log(`[search] cache has only ${cached.papers.length} papers, forcing re-search`);
    searchCache.delete(cacheKey);
  }
  if (cached && channel === "web" && !patentsOnly && (!cached.papers?.length || cached.papers.length < 3)) {
    console.log(`[search] cache had ${cached.papers?.length ?? 0} web papers, forcing re-search`);
    searchCache.delete(cacheKey);
  }

  const sourcesUsed = [];
  if (coreQueryExtracted) sourcesUsed.push("search:core_query_extracted");
  const buckets = [];

  if (channel === "web" && !patentsOnly) {
    /** 网页渠道：仅全网 SERP + 可选专利；不查 arXiv/Crossref/Scopus/本地论文库 */
    sourcesUsed.push(
      isWebChannelPatentsEnabled() ? "mode:web_patent_intel" : "mode:web_only",
    );
    const webIntel = await runWebIntelSearch({
      fullRawQuery: fullContextQuery,
      rawQuery,
      effectiveQuery,
      max,
      useMcpWeb,
      includePatents: isWebChannelPatentsEnabled(),
      performanceTrace,
    });
    sourcesUsed.push(...webIntel.sourcesUsed);
    if (webIntel.patents.length) buckets.push(webIntel.patents);
    if (webIntel.papers.length) buckets.push(webIntel.papers);
  } else if (!patentsOnly && channel === "database") {
  // 数据库渠道：本地库 + 论文索引 + 专利/网页补充（网页渠道不会进入此分支）
  
  // 第0层：本地数据库（PostgreSQL + SQLite）
  if (channel === "database") {
    // 1. 如果连接了 PostgreSQL (material_kb)，优先查询 DOI 记录（277万条）
    if (isPostgres()) {
      try {
        console.log("[search] Querying doi_records with:", effectiveQuery);
        const doiRows = await searchDoiRecords(effectiveQuery, max);
        console.log("[search] doi_records returned:", doiRows.length, "rows");
        if (doiRows.length > 0) {
          const doiPapers = doiRows.map(doiRecordToApiPaper);
          console.log("[search] doi_records papers:", doiPapers.length);
          sourcesUsed.push("material_kb_doi");
          buckets.push(doiPapers);
        }

        const fullPaperRows = await searchFullPapers(effectiveQuery, max);
        if (fullPaperRows.length > 0) {
          const fullPapers = fullPaperRows.map(materialKbRowToApiPaper);
          sourcesUsed.push("material_kb_papers");
          buckets.push(fullPapers);
        }
      } catch (e) {
        console.warn("[search] material_kb query failed", e?.message || e);
        sourcesUsed.push("material_kb_error");
      }
    }

    // 2. 仅在未配置 PostgreSQL 时查询本地 SQLite。
    // sql.js 不能由校园版和企业版两个服务进程同时打开同一个文件。
    if (!isPostgres()) {
      const localRows = await searchLocalPapers(effectiveQuery, Math.min(60, max + 20));
      if (localRows.length) {
        const localPapers = localRows.map(rowToApiPaper);
        sourcesUsed.push("local_sqlite");
        buckets.push(localPapers);
      }
    }
  }

  // 第1-3层：网络来源（所有渠道都执行，确保结果充足）
  {
    /** 中文检索式在 arXiv 的 ti:/abs: 下几乎无命中，外网源统一用 all */
    const arxivField =
      /[\u4e00-\u9fff]/.test(String(effectiveQuery ?? "")) && field !== "all" ? "all" : field;
    if (arxivField !== field) sourcesUsed.push("arxiv_field:all_for_zh");
    const aq = buildArxivSearchQuery(effectiveQuery, arxivField);
    const arxivSort = sort === "citations" ? "relevance" : mapArxivSort(sort);
    const doiHit = extractDoiCandidate(effectiveQuery);
    
    /** 
     * 网页渠道：分层并行搜索策略
     * 第0层（本地保底）：SQLite 本地数据库 - 始终查询作为保底
     * 第1层（快速核心源）：arXiv, Crossref, OpenAlex, Semantic Scholar - 15秒超时
     * 第2层（高质量源）：Scopus - 18秒超时
     * 第3层（补充源）：Patents, Europe PMC, MCP - 18秒超时，始终执行以获取专利和网页
     */
    
    // 第0层：SQLite 部署使用本地数据库保底；PostgreSQL 部署不得再打开 sql.js。
    if (!isPostgres()) {
      const localRows = await searchLocalPapers(effectiveQuery, Math.min(60, max + 20));
      if (localRows.length) {
        sourcesUsed.push("local_sqlite");
        buckets.push(localRows.map(rowToApiPaper));
      }
    }
    
    // 第1层：快速核心源（通常响应快）
    const layer1Results = await raceWithTimeout([
      { name: 'arxiv', promise: traceAsync(performanceTrace, "search.database.arxiv", {}, () => fetchArxiv({ searchQuery: aq, max: Math.min(70, max + 25), sort: arxivSort }), (rows) => ({ results: rows?.length ?? 0 })) },
      { name: 'crossref', promise: traceAsync(performanceTrace, "search.database.crossref", {}, () => fetchCrossrefWorks(effectiveQuery, Math.min(50, max + 20)), (rows) => ({ results: rows?.length ?? 0 })) },
      { name: 'openalex', promise: traceAsync(performanceTrace, "search.database.openalex", {}, () => fetchOpenAlexWorks(effectiveQuery, Math.min(50, max + 20)), (rows) => ({ results: rows?.length ?? 0 })) },
      { name: 'semantic_scholar', promise: traceAsync(performanceTrace, "search.database.semantic_scholar", {}, () => fetchSemanticScholarWorks(effectiveQuery, Math.min(50, max + 20)), (rows) => ({ results: rows?.length ?? 0 })) },
    ], 18000); // 18秒超时
    
    let arxiv = [], crossSearch = [], oaSearch = [], semanticSearch = [];
    
    for (const r of layer1Results) {
      if (r.status === 'fulfilled') {
        switch (r.name) {
          case 'arxiv': arxiv = r.value; sourcesUsed.push('arxiv'); break;
          case 'crossref': crossSearch = r.value; sourcesUsed.push('crossref'); break;
          case 'openalex': oaSearch = r.value; sourcesUsed.push('openalex'); break;
          case 'semantic_scholar': semanticSearch = r.value; if (r.value.length) sourcesUsed.push('semantic_scholar'); break;
        }
      } else {
        console.warn(`[search] ${r.name} timeout/failed:`, r.reason);
        sourcesUsed.push(`${r.name}_error`);
      }
    }
    
    // 第2层：高质量源 Scopus（通常较慢但质量高）
    const scopusResult = await raceWithTimeout([
      { name: 'scopus', promise: traceAsync(performanceTrace, "search.database.scopus", {}, () => fetchScopusWorks(effectiveQuery, Math.min(60, max + 30)), (rows) => ({ results: rows?.length ?? 0 })) }
    ], 18000); // 18秒超时
    
    let scopusSearch = [];
    const scopusR = scopusResult[0];
    if (scopusR?.status === 'fulfilled') {
      scopusSearch = scopusR.value;
      if (scopusSearch.length) sourcesUsed.push('scopus');
    } else {
      console.warn('[search] scopus timeout/failed:', scopusR?.reason);
      sourcesUsed.push('scopus_error');
    }
    
    // 合并前两层结果
    let crossBatches = [crossSearch, oaSearch, scopusSearch, semanticSearch];
    
    // DOI精确查询（如果适用）
    if (doiHit) {
      try {
        const byDoi = await fetchCrossrefWorkByDoi(doiHit);
        if (byDoi.length) {
          crossBatches.unshift(byDoi);
          sourcesUsed.push("crossref_doi");
        }
      } catch (e) {
        console.warn('[search] doi fetch failed:', e?.message);
      }
    }
    
    // 第3层：始终获取专利、网页等非文献资源（与文献合并呈现）
    let patentSearch = [], europeSearch = [];
    
    const supplementalTasks = [];

    supplementalTasks.push({
      name: "europepmc",
      promise: traceAsync(performanceTrace, "search.database.europepmc", {}, () => fetchEuropePmcWorks(effectiveQuery, 35), (rows) => ({ results: rows?.length ?? 0 })),
    });

    // 专利 + 全网网页：默认合并（useMcpWeb 为 false 时跳过外呼，便于离线/合规场景）
    if (useMcpWeb !== false) {
      // OpenAlex 专利 API（独立调用，结果标记为 openalex_patent）
      supplementalTasks.push({
        name: "openalex_patents",
        promise: traceAsync(performanceTrace, "search.database.openalex_patents", {}, () => fetchOpenAlexPatents(effectiveQuery, 35), (rows) => ({ results: rows?.length ?? 0 })),
      });
      supplementalTasks.push({
        name: "patents",
        promise: traceAsync(performanceTrace, "search.database.patents", {}, () => fetchPatentPapers(effectiveQuery, 35), (value) => ({ results: value?.papers?.length ?? 0 })),
      });
    }
    
    const supplementalResults = await raceWithTimeout(supplementalTasks, 18000);
    
    for (const r of supplementalResults) {
      if (r.status === 'fulfilled') {
        switch (r.name) {
          case "openalex_patents":
            const oaPatVal = r.value;
            const oaPatPapers = Array.isArray(oaPatVal) ? oaPatVal : [];
            if (oaPatPapers.length) {
              patentSearch = [...patentSearch, ...oaPatPapers];
              sourcesUsed.push("openalex_patents");
            }
            break;
          case "patents":
            const ptVal = r.value;
            const patPapers = ptVal && typeof ptVal === "object" ? (ptVal.papers ?? []) : [];
            patentSearch = Array.isArray(patPapers) ? patPapers : (Array.isArray(ptVal) ? ptVal : []);
            if (patentSearch.length) {
              const ptTool = (ptVal && ptVal.toolName) || "patents";
              sourcesUsed.push(ptTool ? `patents:${ptTool}` : "patents");
            }
            break;
          case 'europepmc': 
            europeSearch = r.value; 
            if (europeSearch.length) sourcesUsed.push('europepmc'); 
            break;
        }
      } else {
        console.warn(`[search] ${r.name} timeout/failed:`, r.reason);
        sourcesUsed.push(`${r.name}_error`);
      }
    }

    /** 数据库渠道：并行全网多路检索，与文献/自建库结果合并 */
    if (useMcpWeb !== false) {
      const webIntel = await runWebIntelSearch({
        fullRawQuery,
        rawQuery,
        effectiveQuery,
        max,
        useMcpWeb: true,
        includePatents: false,
        performanceTrace,
      });
      if (webIntel.sourcesUsed.length) sourcesUsed.push(...webIntel.sourcesUsed);
      if (webIntel.papers.length) {
        buckets.push(webIntel.papers);
        sourcesUsed.push("mode:database_plus_web");
      }
    }

    /** Scopus 放最后传入 mergeDedupe，同 DOI 时优先保留爱思唯尔题录（scoreSource 已最高） */
    buckets.push(arxiv, mergeDedupe(crossBatches));
    if (patentSearch.length) buckets.push(patentSearch);
    if (europeSearch.length) buckets.push(europeSearch);
    let interim = mergeDedupe(buckets);
    
    // 如果外部源结果不足，再补充本地数据库（第0层已查询过，这里只在仍不足时追加）
    if (!isPostgres() && interim.length < max) {
      const localRows = await searchLocalPapers(effectiveQuery, max - interim.length + 15);
      if (localRows.length) {
        sourcesUsed.push("local_sqlite_supplement");
        buckets.push(localRows.map(rowToApiPaper));
      }
    }
  }
  } else {
    /** 仅专利：不查论文索引、Europe PMC、网页 SERP；只并联 OpenAlex 专利 + DDG/MCP 专利 */
    let patentSearchOnly = [];
    const poTasks = [];
    if (useMcpWeb !== false) {
      poTasks.push({
        name: "openalex_patents",
        promise: fetchOpenAlexPatents(effectiveQuery, 45),
      });
      poTasks.push({
        name: "patents",
        promise: fetchPatentPapers(effectiveQuery, 45),
      });
    }
    const poResults = await raceWithTimeout(poTasks, 25000);
    for (const r of poResults) {
      if (r.status === "fulfilled") {
        switch (r.name) {
          case "openalex_patents": {
            const oaPatVal = r.value;
            const oaPatPapers = Array.isArray(oaPatVal) ? oaPatVal : [];
            if (oaPatPapers.length) {
              patentSearchOnly = patentSearchOnly.concat(oaPatPapers);
              sourcesUsed.push("openalex_patents");
            }
            break;
          }
          case "patents": {
            const ptVal = r.value;
            const patPapers = ptVal && typeof ptVal === "object" ? (ptVal.papers ?? []) : [];
            const arr = Array.isArray(patPapers) ? patPapers : Array.isArray(ptVal) ? ptVal : [];
            if (arr.length) {
              patentSearchOnly = patentSearchOnly.concat(arr);
              const ptTool = ptVal && ptVal.toolName;
              sourcesUsed.push(ptTool ? `patents:${ptTool}` : "patents");
            }
            break;
          }
          default:
            break;
        }
      } else {
        console.warn(`[search] ${r.name} timeout/failed:`, r.reason);
        sourcesUsed.push(`${r.name}_error`);
      }
    }
    if (patentSearchOnly.length) buckets.push(patentSearchOnly);
    sourcesUsed.push("mode:patents_only");
    if (useMcpWeb === false) sourcesUsed.push("patents_only_skipped_mcp_web");
  }

  let merged = mergeDedupe(buckets);
  const beforeFilter = merged.length;
  merged = dropZeroRelevanceByTokens(merged, rawQuery, effectiveQuery, opts.preferenceKeywords);
  if (merged.length > 0 && merged.length < beforeFilter) {
    sourcesUsed.push("relevance_token_drop");
  }
  const semanticTokens = buildSemanticTokens(queryIntent);
  const mergedTokens = [
    ...extractQueryTokensMerged(rawQuery, effectiveQuery, opts.preferenceKeywords),
    ...semanticTokens,
  ].filter((w, i, arr) => arr.indexOf(w) === i).slice(0, 48);
  const beforeStrict = merged.length;
  merged = strictRecommendFilterAndRank(merged, mergedTokens, max, {
    preferenceCount: normalizePreferenceKeywords(opts.preferenceKeywords).length,
    channel,
    rawQuery: opts.rawQuery,
    effectiveQuery,
    semanticIntent: queryIntent,
  });
  if (merged.length > 0 && merged.length < beforeStrict) {
    sourcesUsed.push("strict_recommend_filter");
  }
  if (queryIntent) {
    const semTag = String(queryIntent.note ?? "ok");
    sourcesUsed.push(semTag.startsWith("semantic:") ? semTag : `semantic:${semTag}`);
    const embedRerank = await rerankPapersByEmbedding(merged, rawQuery, queryIntent, {
      apiKey: opts.openaiApiKey,
    });
    if (embedRerank.note && embedRerank.note !== "embed:skipped") {
      sourcesUsed.push(embedRerank.note);
    }
    if (embedRerank.papers?.length) merged = embedRerank.papers;
  }
  merged = applySort(merged, sort);
  merged = merged.slice(0, max);
  if (channel === "web" && !patentsOnly) {
    const beforeInc = merged.length;
    const webPreInc = merged.length ? [...merged] : [];
    const inc = filterWebChannelInclusion(merged, rawQuery, effectiveQuery, max);
    merged = inc.papers;
    if (inc.dropped > 0) sourcesUsed.push(`web_strict_drop:${inc.dropped}`);
    if (merged.length < beforeInc) sourcesUsed.push("web_inclusion_filter");
    if (!merged.length && webPreInc.length) {
      merged = finalizeWebPatentIntelRows(webPreInc.slice(0, max), max);
      sourcesUsed.push(`web_list_salvage:${merged.length}`);
    }
    /** 按「作答相关度」重排：合并多路 SERP 时顺序随机，避免旅游/百科页在前导致模型跟风跑题 */
    if (merged.length > 1) {
      const fullTok = `${String(rawQuery ?? "").trim()}\n${String(effectiveQuery ?? "").trim()}`.trim();
      const coreTok =
        extractCoreSearchQuery(String(rawQuery ?? "").trim()) || extractCoreSearchQuery(fullTok) || fullTok;
      const tokens = buildWebAnswerTokens(fullTok);
      merged = [...merged].sort(
        (a, b) =>
          scoreWebPaperForAnswer(b, tokens, coreTok, fullTok) -
          scoreWebPaperForAnswer(a, tokens, coreTok, fullTok),
      );
      sourcesUsed.push("web_score_resort");
    }
    if (!merged.length) {
      const salvageSeeds = buildEntityDirectWebSeeds(rawQuery);
      if (salvageSeeds.length) {
        merged = finalizeWebPatentIntelRows(salvageSeeds, max);
        sourcesUsed.push(`web_zero_salvage:${merged.length}`);
      }
    }
    const beforeWi = merged.length;
    merged = finalizeWebPatentIntelRows(merged, max);
    if (merged.length < beforeWi) sourcesUsed.push("web_intel_filter");
    sourcesUsed.push("web_patent_intel_rows");
  } else if (patentsOnly) {
    merged = finalizePatentsOnlyRows(merged, max);
    sourcesUsed.push("patents_only_rows");
  }

  try {
    try {
      const hasWebInMerged = merged.some((p) => isWebPageResultPaper(p));
      const webEnrich = await enrichPapersWithWebPageContent(merged, {
        maxPages:
          channel === "web"
            ? Math.min(40, Math.max(12, Number(process.env.WEB_FETCH_MAX_PAGES) || 32))
            : hasWebInMerged
              ? Math.min(28, Math.max(10, Number(process.env.DB_WEB_FETCH_MAX_PAGES) || 18))
              : Number(process.env.WEB_FETCH_MAX_PAGES) || 10,
        forceFetchAll: channel === "web",
        performanceTrace,
      });
      if (webEnrich.fetched > 0) {
        sourcesUsed.push(`web_page_fetch:${webEnrich.fetched}`);
        merged = webEnrich.papers;
      } else if (webEnrich.attempted > 0) {
        sourcesUsed.push(`web_page_fetch:0/${webEnrich.attempted}`);
      }
    } catch (e) {
      console.warn("[search] web_page_fetch failed:", e?.message || e);
      sourcesUsed.push("web_page_fetch:error");
    }
    await upsertPapers(toIngestRows(merged), `batch:${channel}:${started}`);
  } catch (e) {
    console.error("[search] upsert failed", e);
  }

  const latencyMs = Date.now() - started;
  
  const result = {
    papers: merged,
    effectiveQuery,
    rewriteNote: rw.note,
    queryIntent: compactQueryIntent(queryIntent),
    sourcesUsed,
    channel,
    sort,
    field,
    latencyMs,
    arxivSortUsed: sort === "citations" ? "relevance" : mapArxivSort(sort),
  };
  
  // 保存到缓存
  const webMinCache =
    channel === "web" && !patentsOnly
      ? Math.max(3, Number(process.env.WEB_CACHE_MIN_PAPERS) || 3)
      : 12;
  if ((result.papers?.length ?? 0) >= webMinCache) {
    searchCache.set(cacheKey, result);
    console.log(`[search] cached result for "${opts.rawQuery.slice(0, 30)}..." (${latencyMs}ms)`);
  } else {
    searchCache.delete(cacheKey);
    console.log(
      `[search] skip cache (${result.papers?.length ?? 0} papers < ${webMinCache}) for "${opts.rawQuery.slice(0, 30)}..."`,
    );
  }
  
  return result;
}
