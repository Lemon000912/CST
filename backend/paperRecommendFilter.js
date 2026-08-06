/**
 * 论文推荐：主题相关性、去重与期刊/引用质量排序（Scopus 等索引来源加权，近似「高质量期刊」优先）。
 * 与 searchService 中的 token 抽取配合使用。
 */
import { webEntityAliasBoost } from "./webEntitySearch.js";
import { isWeatherWebIntent, isWebOfftopicForQuery } from "./webRelevance.js";
import { semanticRelevanceScore } from "./semanticUnderstand.js";
import { fuzzyTokenMatch } from "./queryTypoCorrect.js";
import { webSearchRecallMode } from "./searchRecall.js";

const WEB_SOURCES = new Set([
  "mcp_web",
  "ddg_web",
  "dataify_web",
  "tavily_web",
  "searx_web",
  "qwant_web",
  "mojeek_web",
  "entity_seed",
]);

function isWebSource(p) {
  return WEB_SOURCES.has(String(p?.source ?? ""));
}

function isPatentSource(p) {
  const s = String(p?.source ?? "");
  return s === "ddg_patent" || s === "openalex_patent";
}

/** 检索词与网页标题明显无关的噪声（如误命中 WhatsApp Web） */
function isObviousWebNoise(p, tokens, rawQuery) {
  if (!isWebSource(p)) return false;
  const blob = `${p.title || ""} ${p.summary || ""} ${p.absUrl || ""}`.toLowerCase();
  const noiseRe =
    /whatsapp|weixin\.qq\.com\/(?!s\/)|facebook\.com|twitter\.com|instagram\.com|tiktok\.com|youtube\.com\/watch|taobao\.com|jd\.com\/product\/0/i;
  if (!noiseRe.test(blob)) return false;
  const techTokens = tokens.filter((t) => /[a-zA-Z]{3,}/i.test(String(t)) || /[\u4e00-\u9fff]{2,}/.test(String(t)));
  const materialHint =
    /聚氨酯|polyurethane|spu|涂料|coating|防水|elastomer|桥隧|patent|专利/i.test(
      `${techTokens.join(" ")} ${rawQuery || ""}`,
    );
  return materialHint;
}

/** @param {object} p */
export function sourceTier(p) {
  const s = String(p.source ?? "");
  if (s === "scopus") return 100;
  if (s === "local") return 45;
  if (s === "semantic_scholar") return 55;
  if (s === "openalex_patent") return 44;
  if (s === "europepmc") return 41;
  if (s === "openalex") return 38;
  if (s === "arxiv") return 18;
  if (s === "dataify_web") return 38;
  if (s === "tavily_web") return 40;
  if (s === "searx_web") return 37;
  if (s === "mcp_web") return 36;
  if (s === "qwant_web") return 35;
  if (s === "ddg_web") return 34;
  if (s === "mojeek_web") return 33;
  if (s === "ddg_patent") return 40;
  return 25;
}

/** 网页渠道时提高 SERP 条目排序权重 */
function sourceTierWithChannel(p, channel) {
  const t = sourceTier(p);
  if (channel !== "web" || !isWebSource(p)) return t;
  return t + 14;
}

/**
 * 期刊/渠道质量加分：正式出版物名称、高被引等（无法可靠判定 SCI 时用工学启发式）。
 * @param {object} p
 */
export function venueImpactBoost(p) {
  const venue = String(p.venue ?? "").trim();
  let bonus = 0;
  if (venue && venue !== "Scopus" && venue !== "OpenAlex") {
    bonus += 12;
    if (/^patent\b|^patent ·/i.test(venue)) bonus += 10;
    const v = venue.toLowerCase();
    if (
      /\bjournal\b|\bletters\b|\bproceedings\b|\breview\b|\bnature\b|\bscience\b|\bcell\b|\bieee\b|\bacm\b|\bspringer\b|\belsevier\b|\bwiley\b|\bacs\b|\brsc\b|\btaylor\b/i.test(
        venue,
      )
    ) {
      bonus += 18;
    }
  }
  const cites = Number(p.isReferencedByCount);
  if (Number.isFinite(cites) && cites > 0) {
    bonus += Math.min(35, Math.log1p(cites) * 4.5);
  }
  return bonus;
}

/**
 * @param {object} p
 * @param {string[]} tokens
 */
export function relevanceRatio(p, tokens) {
  const raw = `${p.title || ""} ${p.summary || p.abstract || ""}`;
  const blob = raw.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    const s = String(t);
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (fuzzyTokenMatch(raw, s)) hits++;
    } else {
      const tl = s.toLowerCase();
      if (tl.length >= 2 && (blob.includes(tl) || fuzzyTokenMatch(raw, tl))) hits++;
    }
  }
  const denom = Math.max(1, tokens.length);
  return hits / denom;
}

function extractChinesePhrasesForFilter(raw) {
  const m = String(raw ?? "").match(/[\u4e00-\u9fff]{2,12}/g);
  if (!m?.length) return [];
  const seen = new Set();
  const out = [];
  for (const w of m) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}

const WEB_OFFTOPIC_RE_FOR_FILTER =
  /市人民政府|人民政府网|门户网站|政务公开|便民服务|旅游攻略|必去景点|景区攻略|自由行|一日游|携程|同程|马蜂窝|穷游|途牛|天气预报|行政区划|招聘信息|58同城|知乎\s*问题|微博|抖音|词典|翻译在线|百度百科\s*[·\-—]?\s*[^·\n]{0,10}(市|省|区|县)(?!.*(?:公司|企业|股份|产品|材料|专利|聚氨酯|化工))/i;

/** 从语义理解结果抽取中文材料/检索词，用于网页标题与正文匹配（改写为英文时原文里仍可能有中文实体） */
function extractSemanticIntentZhPhrases(intent) {
  if (!intent || typeof intent !== "object") return [];
  const out = [];
  const push = (s) => {
    const t = String(s ?? "").trim();
    if (t.length < 2 || !/[\u4e00-\u9fff]/.test(t)) return;
    out.push(t.slice(0, 40));
  };
  for (const key of ["materials", "properties", "searchTerms", "typoFixes"]) {
    const arr = intent[key];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) push(x);
  }
  push(intent.topic);
  if (intent.summaryZh) {
    for (const ph of extractChinesePhrasesForFilter(intent.summaryZh)) {
      if (ph.length >= 3) out.push(ph);
    }
  }
  return [...new Set(out)].slice(0, 28);
}

/** 纯中文问题下要求网页与问题有短语或型号级关联（避免仅命中「市」「公司」等跑题页） */
function webPassesChineseRelevance(p, rawQuery, effectiveQuery, intentExtraZh = []) {
  const text = `${p.title || ""} ${p.summary || p.abstract || ""}`;
  const phrases = [
    ...extractChinesePhrasesForFilter(rawQuery),
    ...extractChinesePhrasesForFilter(effectiveQuery),
  ].filter((ph) => ph.length >= 3);
  if (phrases.some((ph) => text.includes(ph))) return true;
  const intentZh = Array.isArray(intentExtraZh) ? intentExtraZh : [];
  if (intentZh.some((ph) => String(ph).length >= 2 && text.includes(String(ph)))) return true;
  const codes = `${rawQuery || ""} ${effectiveQuery || ""}`.match(/\b[A-Z]{2,8}[-_]?\d{2,6}\b/gi);
  if (codes?.some((c) => text.toUpperCase().includes(String(c).toUpperCase()))) return true;
  if (/聚氨酯|polyurethane|涂料|防水|专利|polymer|elastomer/i.test(`${rawQuery} ${effectiveQuery}`)) {
    if (WEB_OFFTOPIC_RE_FOR_FILTER.test(text)) return false;
  }
  if (webEntityAliasBoost(p, `${rawQuery} ${effectiveQuery}`) >= 60) return true;
  if (webSearchRecallMode()) {
    const en = `${effectiveQuery || ""} ${rawQuery || ""}`.match(/\b[a-zA-Z]{4,}\b/g);
    if (en?.some((w) => text.toLowerCase().includes(w.toLowerCase()))) return true;
    if (intentZh.some((ph) => String(ph).length >= 2 && fuzzyTokenMatch(text, String(ph)))) return true;
  }
  return false;
}

function countTokenHitsForFilter(p, tokens) {
  const raw = `${p.title || ""} ${p.summary || p.abstract || ""}`;
  const blob = raw.toLowerCase();
  let hitCount = 0;
  for (const t of tokens) {
    const s = String(t);
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (fuzzyTokenMatch(raw, s)) hitCount++;
    } else {
      const tl = s.toLowerCase();
      if (tl.length >= 2 && (blob.includes(tl) || fuzzyTokenMatch(raw, tl))) hitCount++;
    }
  }
  return hitCount;
}

function passesRelevanceGate(p, tokens, prefN, opts) {
  if (isObviousWebNoise(p, tokens, opts?.rawQuery)) return false;

  const r = relevanceRatio(p, tokens);
  const hitCount = countTokenHitsForFilter(p, tokens);

  const minRatio = prefN >= 2 ? 0.14 : prefN >= 1 ? 0.12 : 0.1;
  const minHits = tokens.length >= 5 ? 2 : 1;
  const webMinRatio = prefN >= 1 ? 0.22 : 0.2;
  const webMinHits = 2;
  const webChannel = opts?.channel === "web";

  if (isPatentSource(p)) {
    if (webChannel) {
      if (WEB_OFFTOPIC_RE_FOR_FILTER.test(`${p.title || ""} ${p.summary || ""}`)) return false;
      if (webEntityAliasBoost(p, `${opts?.rawQuery || ""} ${opts?.effectiveQuery || ""}`) >= 50) return true;
      return hitCount >= 1 && r >= 0.1;
    }
    if (hitCount >= 1) return true;
    if (r >= 0.08) return true;
    return hitCount >= 1 || r >= 0.05;
  }

  if (isWebSource(p)) {
    if (WEB_OFFTOPIC_RE_FOR_FILTER.test(`${p.title || ""} ${p.summary || ""} ${p.absUrl || ""}`)) return false;
    if (!webPassesChineseRelevance(p, opts.rawQuery, opts.effectiveQuery, opts?.intentExtraZh)) return false;
    const alias = webEntityAliasBoost(p, `${opts?.rawQuery || ""} ${opts?.effectiveQuery || ""}`);
    if (alias >= 70) return true;
    if (webChannel) {
      const recall = webSearchRecallMode();
      if (recall) {
        return (hitCount >= 1 && r >= 0.06) || hitCount >= 2 || alias >= 45;
      }
      return (hitCount >= webMinHits && r >= 0.14) || (hitCount >= 3) || (r >= webMinRatio && hitCount >= 1);
    }
    if (hitCount >= webMinHits) return true;
    if (r >= webMinRatio) return true;
    return false;
  }

  if (hitCount >= minHits) return true;
  if (r >= minRatio) return true;
  return false;
}

/**
 * 严格剔除弱相关与近似重复标题；按来源层级 + 期刊/引用综合排序。
 * @param {object[]} papers
 * @param {string[]} mergedTokens 问题 + 检索式 + 用户喜好词
 * @param {number} max 上限（过滤后至多再截断到此）
 * @param {{ preferenceCount?: number; channel?: string; rawQuery?: string; effectiveQuery?: string; semanticIntent?: import('./semanticUnderstand.js').QueryIntent|null }} [opts]
 */
export function strictRecommendFilterAndRank(papers, mergedTokens, max, opts) {
  const prefN = Math.max(0, Math.min(24, Number(opts?.preferenceCount) || 0));
  const channel = opts?.channel === "web" ? "web" : "database";
  const list = Array.isArray(papers) ? [...papers] : [];
  const tokens = Array.isArray(mergedTokens) ? mergedTokens : [];
  let working = list;

  const norm = (t) =>
    String(t ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
      .trim()
      .slice(0, 140);

  const hasChineseToken = tokens.some((t) => /[\u4e00-\u9fff]/.test(String(t)));
  const hasEnglishToken = tokens.some((t) => /[a-zA-Z]/.test(String(t)));
  const isChineseOnlyQuery = hasChineseToken && !hasEnglishToken;

  const semanticIntent = opts?.semanticIntent ?? null;
  const semanticWeight = semanticIntent ? 95 : 0;

  const intentExtraZh = extractSemanticIntentZhPhrases(opts?.semanticIntent);
  const gateOpts = {
    isChineseOnlyQuery,
    rawQuery: opts?.rawQuery,
    effectiveQuery: opts?.effectiveQuery,
    channel,
    intentExtraZh,
  };

  const blendScore = (p, rel, hits, tier, ven) => {
    const sem = semanticIntent ? semanticRelevanceScore(p, semanticIntent) : 0;
    if (channel === "web") {
      let score = rel * 600 + hits * 120 + sem * semanticWeight;
      score += webEntityAliasBoost(p, `${opts?.rawQuery || ""} ${opts?.effectiveQuery || ""}`);
      return score;
    }
    return tier + ven + rel * 80 + sem * semanticWeight;
  };

  if (list.length <= 12) {
    let smallList = list;
    if (channel === "web" && tokens.length >= 1) {
      smallList = list.filter((p) => passesRelevanceGate(p, tokens, prefN, gateOpts));
      if (!smallList.length) smallList = list;
    }
    const scored = smallList.map((p) => {
      const rel = tokens.length ? relevanceRatio(p, tokens) : 0;
      const hits = countTokenHitsForFilter(p, tokens);
      const tier = sourceTierWithChannel(p, channel);
      const ven = venueImpactBoost(p);
      let score = blendScore(p, rel, hits, tier, ven) + (channel === "web" && isPatentSource(p) ? 50 : 0);
      if (channel === "web") {
        if (isObviousWebNoise(p, tokens, opts?.rawQuery)) score -= 2000;
        const blob = `${opts?.rawQuery || ""} ${opts?.effectiveQuery || ""}`;
        const pt = `${p.title || ""} ${p.summary || ""}`;
        if (
          WEB_OFFTOPIC_RE_FOR_FILTER.test(pt) &&
          !isWeatherWebIntent(blob) &&
          !isWebOfftopicForQuery(pt, blob)
        ) {
          score -= 2500;
        }
      }
      return { p, score, nt: norm(p.title) };
    });
    const bestByNormTitle = new Map();
    for (const x of scored) {
      if (channel === "web" && x.score < -120) continue;
      const k = x.nt || `_id:${String(x.p.paper_id ?? x.p.doi ?? "")}`;
      const prev = bestByNormTitle.get(k);
      if (!prev || x.score > prev.score) bestByNormTitle.set(k, x);
    }
    const smallOut = [...bestByNormTitle.values()]
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
    if (channel === "web" && !smallOut.length && smallList.length) {
      return smallList.slice(0, Math.min(smallList.length, max + 20));
    }
    return smallOut;
  }

  if (tokens.length >= 2) {
    working = list.filter((p) => passesRelevanceGate(p, tokens, prefN, gateOpts));
    if (working.length < Math.min(3, list.length) && channel !== "web") {
      const fallbackRatio = prefN >= 2 ? 0.08 : 0.06;
      working = list.filter((p) => {
        if (isWebSource(p)) return passesRelevanceGate(p, tokens, prefN, gateOpts);
        return relevanceRatio(p, tokens) >= fallbackRatio || sourceTierWithChannel(p, channel) >= 42;
      });
    }
    /** 网页渠道此前未回退：门控过严时会出现「外呼有结果、最终 0 条」 */
    if (working.length === 0 && list.length > 0) {
      working = list.slice(0, Math.min(list.length, max + 10));
    }
  }

  const scored = working.map((p) => {
    const rel = tokens.length ? relevanceRatio(p, tokens) : 0;
    const hits = countTokenHitsForFilter(p, tokens);
    const tier = sourceTierWithChannel(p, channel);
    const ven = venueImpactBoost(p);
    let score = blendScore(p, rel, hits, tier, ven) + (channel === "web" && isPatentSource(p) ? 50 : 0);
    if (channel === "web") {
      if (isObviousWebNoise(p, tokens, opts?.rawQuery)) score -= 2000;
      if (WEB_OFFTOPIC_RE_FOR_FILTER.test(`${p.title || ""} ${p.summary || ""}`)) score -= 2500;
      if (hits < 2 && rel < 0.16) score -= 400;
    }
    return { p, score, rel, hits, nt: norm(p.title) };
  });

  const bestByNormTitle = new Map();
  for (const x of scored) {
    const k = x.nt || `_id:${String(x.p.paper_id ?? x.p.doi ?? "")}`;
    const prev = bestByNormTitle.get(k);
    if (!prev || x.score > prev.score) bestByNormTitle.set(k, x);
  }

  const mergedRanked = [...bestByNormTitle.values()].sort(
    (a, b) => b.score - a.score || String(a.p.title).localeCompare(String(b.p.title)),
  );

  const cap = Math.min(180, Math.max(15, max + 20));

  if (channel === "web" && tokens.length >= 2) {
    const intentBlob = `${opts?.rawQuery || ""} ${opts?.effectiveQuery || ""}`;
    const corp = /(?:公司|企业|集团|股份|产品|主营|002\d{3})|(?:新和成|浙江新和成)|(?:\bNHU\b)/i.test(intentBlob);
    const minStrong = corp ? Math.min(12, cap) : Math.min(6, cap);
    const strong = [];
    for (const x of mergedRanked) {
      if (x.score < 0) continue;
      if (isObviousWebNoise(x.p, tokens, opts?.rawQuery)) continue;
      const alias = webEntityAliasBoost(x.p, intentBlob);
      const relOk = x.rel >= 0.14 || x.hits >= 2 || alias >= 55;
      const patentOk =
        isPatentSource(x.p) && (alias >= 35 || (x.hits >= 1 && x.rel >= 0.08));
      const webOk = isWebSource(x.p) && relOk && (corp ? x.hits >= 1 : x.hits >= 2);
      if (webOk || patentOk) strong.push(x);
    }
    let out = strong.slice(0, cap).map((x) => x.p);
    if (out.length < minStrong) {
      const seen = new Set(out.map((p) => String(p.absUrl ?? "").trim().split("#")[0].toLowerCase()));
      for (const x of mergedRanked) {
        if (out.length >= cap) break;
        const t = `${x.p.title || ""} ${x.p.summary || ""}`;
        if (x.score < -50) continue;
        if (isObviousWebNoise(x.p, tokens, opts?.rawQuery)) continue;
        if (WEB_OFFTOPIC_RE_FOR_FILTER.test(t)) continue;
        if (corp && /游记|旅游攻略|一日游|携程|马蜂窝/i.test(t)) continue;
        const key = String(x.p.absUrl ?? "").trim().split("#")[0].toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(x.p);
      }
    }
    if (out.length) return out;
    const fallback = mergedRanked
      .filter(
        (x) =>
          x.score >= 0 &&
          !isObviousWebNoise(x.p, tokens, opts?.rawQuery) &&
          !WEB_OFFTOPIC_RE_FOR_FILTER.test(`${x.p.title || ""} ${x.summary || ""}`),
      )
      .slice(0, cap);
    return fallback.map((x) => x.p);
  }

  return mergedRanked.slice(0, cap).map((x) => x.p);
}
