/**
 * 语义理解：从用户问题抽取结构化意图，并用于相关度打分 / 可选向量重排。
 */
import {
  resolveApiKey,
  resolveRewriteApiKey,
  resolveChatCompletionsUrl,
  sanitizeModel,
  defaultModel,
  chineseTechnicalFallback,
} from "./rewrite.js";
import { embedTexts, cosineSimilarity, isEmbeddingEnabled } from "./embeddingService.js";
import { fuzzyTokenMatch } from "./queryTypoCorrect.js";

/** @returns {boolean} */
export function isSemanticUnderstandEnabled() {
  if (/^(0|false|off|no)$/i.test(String(process.env.SEMANTIC_UNDERSTAND_DISABLED ?? "").trim())) {
    return false;
  }
  if (/^(0|false|off|no)$/i.test(String(process.env.SEMANTIC_UNDERSTAND_ENABLED ?? "").trim())) {
    return false;
  }
  if (/^(1|true|on|yes)$/i.test(String(process.env.SEMANTIC_UNDERSTAND_ENABLED ?? "").trim())) {
    return true;
  }
  return Boolean(resolveApiKey());
}

/** @param {unknown} v @returns {string[]} */
function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const s = String(x ?? "").trim();
    if (!s || s.length > 120) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 24) break;
  }
  return out;
}

/** @param {string} raw */
function parseIntentJson(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** @param {string} q @returns {import('./semanticUnderstand.js').QueryIntent} */
function ruleBasedIntent(q) {
  const fb = chineseTechnicalFallback(q);
  const enTerms = fb ? fb.split(/\s+/).filter((w) => w.length > 2) : [];
  const zhPhrases = String(q).match(/[\u4e00-\u9fff]{2,8}/g) ?? [];
  const uniqZh = [...new Set(zhPhrases)].slice(0, 8);
  return {
    topic: q.slice(0, 200),
    materials: uniqZh.filter((w) => /材料|合金|纤维|聚合物|陶瓷|金属|涂料|聚氨酯/.test(w)),
    methods: [],
    properties: uniqZh.filter((w) => /性能|强度|阻燃|耐|导|硬度/.test(w)),
    constraints: [],
    searchTerms: enTerms,
    synonyms: [...uniqZh, ...enTerms].slice(0, 20),
    summaryZh: q.slice(0, 120),
    typoFixes: [],
    note: "semantic:rule-fallback",
  };
}

/**
 * @typedef {object} QueryIntent
 * @property {string} topic
 * @property {string[]} materials
 * @property {string[]} methods
 * @property {string[]} properties
 * @property {string[]} constraints
 * @property {string[]} searchTerms
 * @property {string[]} synonyms
 * @property {string} summaryZh
 * @property {string} note
 * @property {string[]} typoFixes 纠错记录，如「聚脂→聚酯」
 * @property {string} [correctedQuery] 纠错后的查询（若有）
 */

/**
 * LLM 结构化意图解析（与检索改写并行，不替代 rewrite 的英文检索式）。
 * @param {string} userQuery
 * @param {{ apiKey?: string; model?: string; chatCompletionsUrl?: string; personaSkill?: string }} [opts]
 * @returns {Promise<QueryIntent|null>}
 */
export async function understandQuery(userQuery, opts = {}) {
  const q = String(userQuery ?? "").trim();
  if (!q || !isSemanticUnderstandEnabled()) return null;

  const key = resolveRewriteApiKey(opts.apiKey) || resolveApiKey(opts.apiKey);
  if (!key) return ruleBasedIntent(q);

  const url = resolveChatCompletionsUrl(opts.chatCompletionsUrl);
  const model = sanitizeModel(opts.model || defaultModel());
  const skillRaw = String(opts.personaSkill ?? "").trim();
  const skillBlock = skillRaw
    ? `User role context (may be Chinese):\n${skillRaw.slice(0, 1600)}\n\n`
    : "";

  const system =
    skillBlock +
    "You analyze academic/material-science search queries. Correct likely typos/错别字 in the user's intent (e.g. 聚脂→聚酯, polyurathane→polyurethane) before extracting terms. " +
    "Output ONLY one JSON object (no markdown) with keys: " +
    'topic (string), materials (string[]), methods (string[]), properties (string[]), constraints (string[]), ' +
    "searchTerms (English keywords for databases), synonyms (bilingual related terms), summaryZh (one Chinese sentence). " +
    "Be concise; arrays max 8 items each.";

  const controller = new AbortController();
  const timeoutMs = Math.min(12000, Math.max(4000, Number(process.env.SEMANTIC_UNDERSTAND_TIMEOUT_MS) || 8000));
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 512,
        messages: [
          { role: "system", content: system },
          { role: "user", content: q },
        ],
      }),
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      console.warn("[semantic] LLM HTTP", r.status);
      return ruleBasedIntent(q);
    }
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
    const parsed = parseIntentJson(text);
    if (!parsed || typeof parsed !== "object") {
      return ruleBasedIntent(q);
    }
    return {
      topic: String(parsed.topic ?? q).slice(0, 300),
      materials: asStringArray(parsed.materials),
      methods: asStringArray(parsed.methods),
      properties: asStringArray(parsed.properties),
      constraints: asStringArray(parsed.constraints),
      searchTerms: asStringArray(parsed.searchTerms),
      synonyms: asStringArray(parsed.synonyms),
      summaryZh: String(parsed.summaryZh ?? "").slice(0, 240) || q.slice(0, 120),
      note: "semantic:llm",
    };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e?.name === "AbortError") {
      return { ...ruleBasedIntent(q), note: "semantic:timeout-fallback" };
    }
    console.warn("[semantic] error", e?.message || e);
    return ruleBasedIntent(q);
  }
}

/**
 * 将意图展开为用于 token 匹配的扩展词表。
 * @param {QueryIntent|null} intent
 * @returns {string[]}
 */
export function buildSemanticTokens(intent) {
  if (!intent) return [];
  const parts = [
    intent.topic,
    ...intent.materials,
    ...intent.methods,
    ...intent.properties,
    ...intent.constraints,
    ...intent.searchTerms,
    ...intent.synonyms,
  ];
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const s = String(p ?? "").trim();
    if (!s || s.length < 2) continue;
    const pieces = /[\u4e00-\u9fff]/.test(s)
      ? [s, ...s.split(/[\s,，、；;]+/).filter((x) => x.length >= 2)]
      : s.split(/[\s,，、；;+/]+/).filter((x) => x.length >= 2);
    for (const piece of pieces) {
      const k = piece.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(piece);
      if (out.length >= 48) return out;
    }
  }
  return out;
}

/**
 * 语义相关度（0~1）：扩展同义词 + 标题加权。
 * @param {object} p
 * @param {QueryIntent|null} intent
 */
export function semanticRelevanceScore(p, intent) {
  if (!intent) return 0;
  const tokens = buildSemanticTokens(intent);
  if (!tokens.length) return 0;

  const title = String(p.title ?? "");
  const summary = String(p.summary ?? p.abstract ?? "");
  const titleL = title.toLowerCase();
  const blobL = `${title} ${summary}`.toLowerCase();

  let weighted = 0;
  let maxW = 0;
  for (const t of tokens) {
    const s = String(t);
    const w = s.length >= 6 ? 1.2 : 1;
    maxW += w * 1.35;
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (title.includes(s)) weighted += w * 1.35;
      else if (blobL.includes(s)) weighted += w;
    } else {
      const tl = s.toLowerCase();
      if (tl.length >= 2 && titleL.includes(tl)) weighted += w * 1.35;
      else if (tl.length >= 2 && blobL.includes(tl)) weighted += w;
    }
  }
  return maxW > 0 ? Math.min(1, weighted / maxW) : 0;
}

/**
 * 对候选文献做可选向量重排（仅处理前 cap 条，控制 API 成本）。
 * @param {object[]} papers
 * @param {string} rawQuery
 * @param {QueryIntent|null} intent
 * @param {{ apiKey?: string; embeddingsUrl?: string }} [opts]
 */
export async function rerankPapersByEmbedding(papers, rawQuery, intent, opts = {}) {
  if (!isEmbeddingEnabled() || !Array.isArray(papers) || papers.length < 2) {
    return { papers, note: "embed:skipped" };
  }
  const cap = Math.min(60, Math.max(12, Number(process.env.SEMANTIC_EMBED_RERANK_CAP) || 40));
  const head = papers.slice(0, cap);
  const tail = papers.slice(cap);

  const queryText = [
    rawQuery,
    intent?.summaryZh,
    intent?.topic,
    ...(intent?.searchTerms ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000);

  const docTexts = head.map((p) =>
    `${p.title || ""}\n${(p.summary || p.abstract || "").slice(0, 1200)}`.trim().slice(0, 1500),
  );

  const vectors = await embedTexts([queryText, ...docTexts], {
    apiKey: opts.apiKey,
    embeddingsUrl: opts.embeddingsUrl,
  });
  if (!vectors || vectors.length < 2) {
    return { papers, note: "embed:unavailable" };
  }

  const qVec = vectors[0];
  const scored = head.map((p, i) => ({
    p,
    embedScore: cosineSimilarity(qVec, vectors[i + 1] ?? []),
  }));
  scored.sort((a, b) => b.embedScore - a.embedScore);
  return {
    papers: [...scored.map((x) => x.p), ...tail],
    note: `embed:rerank:${scored.length}`,
  };
}

/** 供 API 返回的精简意图（不含过长数组） */
export function compactQueryIntent(intent) {
  if (!intent) return null;
  return {
    topic: intent.topic,
    summaryZh: intent.summaryZh,
    materials: intent.materials?.slice(0, 6),
    properties: intent.properties?.slice(0, 6),
    searchTerms: intent.searchTerms?.slice(0, 8),
    typoFixes: intent.typoFixes?.slice(0, 6),
    correctedQuery: intent.correctedQuery,
    note: intent.note,
  };
}
