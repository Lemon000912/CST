/**
 * 网页渠道：作答前相关度打分与跑题剔除（避免联网回答写市政府、城市百科等无关内容）。
 */
import { extractCoreSearchQuery } from "./searchQueryNormalize.js";
import { relevanceRatio } from "./paperRecommendFilter.js";
import { webEntityAliasBoost } from "./webEntitySearch.js";
import {
  BOOK_CLUE_PAGE_RE,
  extractBookTitles,
  isBookIntentQuery,
  isBookCluePaper,
  scoreBookCluePaper,
} from "./bookWebClues.js";
import { webSearchRecallMode, webIncludeMinScore } from "./searchRecall.js";

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
const PATENT_SOURCES = new Set(["ddg_patent", "openalex_patent"]);

/** 与检索问题无关：政府门户、城市百科、社交/电商/招聘等 */
export const WEB_OFFTOPIC_RE =
  /市人民政府|人民政府网|门户网站|政务公开|便民服务|领导活动|人事任免|政府工作报告|行政区划|城市规划|旅游攻略|天气预报|景点介绍|必去景点|景区攻略|游玩指南|自由行|一日游|携程|同程|马蜂窝|穷游|途牛|驴妈妈|酒店预订|招聘信息|求职招聘|58同城|赶集网|1688\.com批发|淘宝店铺|京东自营(?!.*专利)|知乎\s*问题|微博热搜|抖音|小红书|词典|翻译在线|汉典|新华字典|下载\s*APP|手游|电视剧|综艺|明星八卦|百度百科\s*[·\-—]?\s*[^·\n]{0,10}(市|省|区|县)(?!.*(?:公司|企业|股份|集团|产品|材料|专利|聚氨酯|化工))/i;

const TECH_QUERY_RE =
  /聚氨酯|polyurethane|阻燃|聚酯|纤维|spu[-_]?\d|涂料|防水|密封|弹性体|compound|patent|专利|聚合物|树脂|固化剂|环氧|丙烯|桥隧|重载|工程材料/i;

/** 用户意图偏「企业 / 产品 / 资本」——此类下旅游攻略类网页应强降权或剔除 */
const CORPORATE_WEB_INTENT_RE =
  /(?:公司|企业|集团|股份|上市|主营|业务|产品|厂家|品牌|子公司|投资者|年报|招股|股票|证券|巨潮|cninfo|002\d{3}|60\d{3})|(?:新和成|浙江新和成)|(?:\bNHU\b)/i;

/** 典型旅游 / 休闲向标题或摘要（企业问法下多为跑题） */
const WEB_TRAVEL_JUNK_RE =
  /游记|旅游攻略|必玩|打卡|网红景点|周边游|周末游|深度游|景区门票|景点大全|一日游|自由行攻略|度假酒店|携程|马蜂窝|同程旅游|途牛|驴妈妈|乐途旅游|搜狐旅游/i;

/** 公告 / IR / 企业信息平台（企业问法下优先） */
const WEB_IR_FINANCE_RE =
  /cninfo\.com\.cn|巨潮资讯|eastmoney\.com|东方财富|10jqka\.com|同花顺|finance\.sina|新浪财经|xueqiu\.com|雪球|qichacha\.com|天眼查|tianyancha\.com|cnhu\.com|nhu\.|annual\s*report|年报|招股说明书|主营业务|投资者关系|深交所|上交所/i;

/** @param {string} blob */
export function isCorporateWebIntent(blob) {
  return CORPORATE_WEB_INTENT_RE.test(String(blob ?? ""));
}

/** 用户问天气/气温等：结果页含「天气预报」不应按政务/旅游跑题规则整批剔除 */
export function isWeatherWebIntent(blob) {
  const s = String(blob ?? "");
  return (
    /(?:今天|明天|后天|本周|未来|最近).{0,16}(?:天气|气温|温度)|(?:天气|气温|多少度|下雨|下雪|降水|穿衣)|weather\s*(?:forecast|today)/i.test(
      s,
    ) && !isCorporateWebIntent(s)
  );
}

/** 是否因跑题正则拒绝该条（天气问法下保留气象类页面） */
export function isWebOfftopicForQuery(text, fullQuery) {
  if (!WEB_OFFTOPIC_RE.test(String(text ?? ""))) return false;
  if (isWeatherWebIntent(fullQuery) && /天气|气象|气温|降水|forecast|weather/i.test(text)) return false;
  return true;
}

const WEB_SPAM_URL_RE = /miit\.gov\.cn\/dxxzsp|beian\.miit\.gov|经营许可证|京ICP备\d/i;

function isWebTravelJunkText(text) {
  return WEB_TRAVEL_JUNK_RE.test(String(text ?? ""));
}

function isWebPaper(p) {
  return WEB_SOURCES.has(String(p?.source ?? ""));
}

function isPatentPaper(p) {
  return PATENT_SOURCES.has(String(p?.source ?? ""));
}

function extractProductCodes(q) {
  const s = String(q ?? "");
  const codes = s.match(/\b[A-Z]{2,8}[-_]?\d{2,6}\b/gi) || [];
  return [...new Set(codes.map((c) => c.toUpperCase()))];
}

function extractEnglishTokens(raw) {
  const m = String(raw ?? "").match(/[A-Za-z][A-Za-z0-9+\-]{2,}/g);
  if (!m?.length) return [];
  const noise = new Set(["the", "and", "for", "with", "from", "this", "that", "web", "http", "https"]);
  const seen = new Set();
  const out = [];
  for (const w of m) {
    const k = w.toLowerCase();
    if (k.length < 3 || noise.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= 20) break;
  }
  return out;
}

function extractChinesePhrases(raw) {
  const m = String(raw ?? "").match(/[\u4e00-\u9fff]{2,14}/g);
  if (!m?.length) return [];
  const stop = new Set(["公司", "产品", "材料", "关于", "简介", "概述", "综合", "方案", "检索", "网页", "渠道"]);
  const seen = new Set();
  const out = [];
  for (const w of m) {
    if (w.length < 2 || stop.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 16) break;
  }
  return out;
}

/** @param {string} userQuery */
export function buildWebAnswerTokens(userQuery) {
  const full = String(userQuery ?? "").trim();
  const core = extractCoreSearchQuery(full) || full;
  const seen = new Set();
  const out = [];
  const push = (w) => {
    const k = /[\u4e00-\u9fff]/.test(w) ? w : w.toLowerCase();
    if (!w || seen.has(k)) return;
    seen.add(k);
    out.push(w);
  };
  for (const w of extractEnglishTokens(core)) push(w);
  for (const w of extractEnglishTokens(full)) push(w);
  for (const w of extractChinesePhrases(core)) push(w);
  for (const w of extractChinesePhrases(full)) push(w);
  for (const c of extractProductCodes(`${core} ${full}`)) push(c);
  /** 易混写实体：保证打分 token 含正式公司名与代码，避免仅命中「宁波」等城市词 */
  if (/宁波\s*新\s*合成|宁波新合成/i.test(full)) {
    for (const w of ["新和成", "浙江新和成", "002001", "NHU", "营养品", "香精香料", "新材料", "主营业务", "股份"]) {
      push(w);
    }
  }
  return out;
}

function countHits(p, tokens) {
  const raw = `${p.title || ""} ${p.summary || p.abstract || ""}`;
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

/**
 * 弱相关但仍有主题锚点（用于强相关池不足时补摘录，供模型受控联想）
 * @param {object} p
 * @param {string[]} tokens
 * @param {string} coreQuery
 * @param {string} fullQuery
 */
export function passesSoftSynthesisAnchor(p, tokens, coreQuery, fullQuery) {
  const text = `${p.title || ""} ${p.summary || ""} ${p.abstract || ""}`;
  if (isWebOfftopicForQuery(text, fullQuery)) return false;
  const intentBlob = `${String(fullQuery ?? "")} ${String(coreQuery ?? "")}`;
  if (CORPORATE_WEB_INTENT_RE.test(intentBlob) && isWebPaper(p) && WEB_TRAVEL_JUNK_RE.test(text)) return false;
  const rel = tokens.length ? relevanceRatio(p, tokens) : 0;
  const hits = countHits(p, tokens);
  const score = scoreWebPaperForAnswer(p, tokens, coreQuery, fullQuery);
  const alias = webEntityAliasBoost(p, fullQuery);
  if (score >= 10 || hits >= 1 || rel >= 0.06 || alias >= 28) return true;
  const phrases = [...extractChinesePhrases(coreQuery), ...extractChinesePhrases(fullQuery)].filter(
    (ph) => ph.length >= 3,
  );
  if (phrases.some((ph) => text.includes(ph))) return true;
  for (const c of extractProductCodes(`${coreQuery} ${fullQuery}`)) {
    if (text.toUpperCase().includes(c)) return true;
  }
  return false;
}

/**
 * @param {object} p
 * @param {string[]} tokens
 * @param {string} coreQuery
 * @param {string} fullQuery
 */
export function scoreWebPaperForAnswer(p, tokens, coreQuery, fullQuery) {
  const text = `${p.title || ""} ${p.summary || ""} ${p.abstract || ""} ${p.absUrl || ""}`;
  const rel = tokens.length ? relevanceRatio(p, tokens) : 0;
  const hits = countHits(p, tokens);
  let score = rel * 100 + hits * 28;

  for (const c of extractProductCodes(`${coreQuery} ${fullQuery}`)) {
    const u = text.toUpperCase();
    if (u.includes(c)) score += 42;
    if (u.includes(c.replace(/-/g, ""))) score += 28;
  }

  const phrases = [
    ...extractChinesePhrases(coreQuery),
    ...extractChinesePhrases(fullQuery),
  ].filter((ph) => ph.length >= 3);
  if (phrases.some((ph) => text.includes(ph))) score += 22;

  if (TECH_QUERY_RE.test(fullQuery) || TECH_QUERY_RE.test(coreQuery)) {
    if (WEB_OFFTOPIC_RE.test(text)) score -= 150;
    if (/^(关于)?[\u4e00-\u9fff]{2,6}(市|省|区)(概况|简介|介绍)/.test(String(p.title ?? ""))) score -= 70;
  }

  if (isWebPaper(p) && hits < 1 && rel < 0.12) score -= 40;

  score += webEntityAliasBoost(p, fullQuery);

  const intentBlob = `${String(fullQuery ?? "")} ${String(coreQuery ?? "")}`;
  if (isBookIntentQuery(intentBlob)) {
    const titles = extractBookTitles(intentBlob);
    score += scoreBookCluePaper(p, titles);
    if (isBookCluePaper(p, titles)) score += 30;
  }

  if (CORPORATE_WEB_INTENT_RE.test(intentBlob) && isWebPaper(p)) {
    if (WEB_TRAVEL_JUNK_RE.test(text)) score -= 150;
    if (WEB_IR_FINANCE_RE.test(text)) score += 55;
    if (
      /baike\.baidu\.com/i.test(text) &&
      !/公司|股份|集团|新和成|NHU|主营|上市|002\d{3}/i.test(text) &&
      /市|旅游|景点|概况|简介/.test(`${p.title || ""}`)
    ) {
      score -= 100;
    }
    if (/(?:toutiao|sohu)\.com/i.test(text) && WEB_TRAVEL_JUNK_RE.test(String(p.title || ""))) score -= 70;
  }

  return score;
}

/**
 * 是否应**收录**进网页渠道结果列表（未达阈值的一律丢弃，不进入摘录/作答）。
 * @param {object} p
 * @param {string[]} tokens
 * @param {string} coreQuery
 * @param {string} fullQuery
 */
export function shouldIncludeWebChannelPaper(p, tokens, coreQuery, fullQuery) {
  if (String(p?.source ?? "") === "entity_seed") return true;

  const text = `${p.title || ""} ${p.summary || ""} ${p.abstract || ""}`;
  const intentBlob = `${String(fullQuery ?? "")} ${String(coreQuery ?? "")}`;
  if (isWebOfftopicForQuery(text, intentBlob)) return false;

  if (CORPORATE_WEB_INTENT_RE.test(intentBlob) && isWebPaper(p) && WEB_TRAVEL_JUNK_RE.test(text)) return false;

  const score = scoreWebPaperForAnswer(p, tokens, coreQuery, fullQuery);
  const rel = tokens.length ? relevanceRatio(p, tokens) : 0;
  const hits = countHits(p, tokens);
  const alias = webEntityAliasBoost(p, fullQuery);

  if (isBookIntentQuery(intentBlob) && isWebPaper(p)) {
    const titles = extractBookTitles(intentBlob);
    if (isBookCluePaper(p, titles)) return true;
    if (titles.some((t) => t && text.includes(t)) && BOOK_CLUE_PAGE_RE.test(text)) return true;
    const bookMin = Number(process.env.BOOK_WEB_INCLUDE_MIN_SCORE);
    const minB = Number.isFinite(bookMin) ? bookMin : 4;
    if (score >= minB || hits >= 1) return true;
  }

  if (isWeatherWebIntent(intentBlob) && isWebPaper(p) && /天气|气象|forecast/i.test(text)) {
    if (hits >= 1 || score >= -30) return true;
  }

  if (isWebPaper(p)) {
    const corp = isCorporateWebIntent(intentBlob);
    const recall = webSearchRecallMode();
    const minScore = webIncludeMinScore(corp);
    if (corp && WEB_IR_FINANCE_RE.test(text) && !WEB_OFFTOPIC_RE.test(text)) return true;
    if (corp && alias >= 45) return true;
    if (score < minScore && alias < (recall ? 55 : 65)) {
      if (!(recall && score >= minScore - 8 && hits >= 1)) return false;
    }
    if (corp) {
      if (hits >= 1 && score >= (recall ? 4 : 8)) return true;
      if (rel >= (recall ? 0.06 : 0.08) && hits >= 1) return true;
    }
    if (!corp && hits >= 1 && score >= (recall ? 2 : 5)) return true;
    if (!corp && rel >= (recall ? 0.08 : 0.12)) return true;
    if (hits < 2 && rel < (recall ? 0.12 : 0.18) && alias < (recall ? 55 : 65)) return false;
    if (rel < (recall ? 0.06 : 0.1) && hits < 1 && alias < (recall ? 35 : 45)) return false;
    return true;
  }

  if (isPatentPaper(p)) {
    const recall = webSearchRecallMode();
    const minScore = Number(process.env.WEB_INCLUDE_MIN_PATENT_SCORE) || (recall ? 10 : 14);
    if (score < minScore && alias < (recall ? 30 : 40)) return false;
    if (hits < 1 && rel < (recall ? 0.06 : 0.1) && alias < (recall ? 30 : 40)) return false;
    return true;
  }

  return false;
}

/**
 * 网页渠道最终收录过滤（列表与摘录均不再出现跑题条）。
 * @param {object[]} papers
 * @param {string} rawQuery
 * @param {string} [effectiveQuery]
 * @param {number} [max]
 */
export function filterWebChannelInclusion(papers, rawQuery, effectiveQuery = "", max = 80) {
  const full = `${String(rawQuery ?? "").trim()}\n${String(effectiveQuery ?? "").trim()}`.trim();
  const core = extractCoreSearchQuery(String(rawQuery ?? "")) || extractCoreSearchQuery(full) || full;
  const tokens = buildWebAnswerTokens(full);
  const cap = Math.min(80, Math.max(1, Number(max) || 40));
  const arr = Array.isArray(papers) ? papers : [];
  const corp = isCorporateWebIntent(full);
  const bookMode = isBookIntentQuery(full);
  const recall = webSearchRecallMode();
  let kept = arr.filter((p) => shouldIncludeWebChannelPaper(p, tokens, core, full));
  const fallbackCap = corp
    ? Math.min(cap, Math.max(recall ? 24 : 16, Number(process.env.WEB_LIST_FALLBACK_CAP) || 24))
    : Math.min(cap, Math.max(recall ? 18 : 8, Number(process.env.WEB_LIST_FALLBACK_CAP) || (recall ? 20 : 14)));
  if (kept.length < fallbackCap && arr.length > kept.length) {
    const seen = new Set(kept.map((p) => String(p.absUrl ?? "").trim().split("#")[0].toLowerCase()));
    const ranked = arr
      .map((p) => ({ p, score: scoreWebPaperForAnswer(p, tokens, core, full) }))
      .filter((x) => {
        const t = `${x.p.title || ""} ${x.p.summary || ""}`;
        if (isWebOfftopicForQuery(t, full)) return false;
        if (corp && isWebTravelJunkText(t)) return false;
        if (WEB_SPAM_URL_RE.test(String(x.p.absUrl ?? ""))) return false;
        if (bookMode && scoreBookCluePaper(x.p, extractBookTitles(full)) >= 50) return true;
        return x.score > (bookMode ? -50 : -35);
      })
      .sort((a, b) => b.score - a.score);
    for (const x of ranked) {
      if (kept.length >= fallbackCap) break;
      const key = String(x.p.absUrl ?? "").trim().split("#")[0].toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      kept.push(x.p);
    }
  }
  /** 仍 0 条：保留 SERP 中得分最高的若干条，避免「外呼有结果、列表为空」 */
  if (kept.length === 0 && arr.length > 0) {
    const salvageCap = Math.min(
      cap,
      Math.max(bookMode ? 8 : 4, Number(process.env.WEB_LIST_SALVAGE_MIN) || (bookMode ? 10 : 6)),
    );
    const seen = new Set();
    const ranked = arr
      .map((p) => ({ p, score: scoreWebPaperForAnswer(p, tokens, core, full) }))
      .filter((x) => !WEB_SPAM_URL_RE.test(String(x.p.absUrl ?? "")))
      .sort((a, b) => b.score - a.score);
    for (const x of ranked) {
      if (kept.length >= salvageCap) break;
      const key = String(x.p.absUrl ?? "").trim().split("#")[0].toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      kept.push(x.p);
    }
  }
  return {
    papers: kept.slice(0, cap),
    dropped: Math.max(0, arr.length - kept.length),
    totalIn: arr.length,
  };
}

/**
 * 仅将强相关网页/专利送入三模型作答；强相关不足时补「弱锚点」摘录（仍排除跑题页），供受控联想。
 * @param {object[]} papers
 * @param {string} userQuery
 * @param {number} [max]
 */
function webSynthStrictMode() {
  if (webSearchRecallMode()) return false;
  const v = String(process.env.WEB_SYNTH_STRICT ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

export function pickWebPatentPapersForSynthesis(papers, userQuery, max = 22, effectiveQuery = "") {
  const full = `${String(userQuery ?? "").trim()}\n${String(effectiveQuery ?? "").trim()}`.trim();
  const core = extractCoreSearchQuery(String(userQuery ?? "")) || extractCoreSearchQuery(full) || full;
  const tokens = buildWebAnswerTokens(full);
  const corp = isCorporateWebIntent(full);
  const strict = webSynthStrictMode();
  const cap = Math.min(36, Math.max(6, Number(max) || (corp ? 28 : 22)));
  const minWeb =
    Number(process.env.WEB_SYNTH_MIN_WEB_SCORE) ||
    (strict ? (corp ? 22 : 26) : webSearchRecallMode() ? 14 : corp ? 16 : 20);
  const minPatent =
    Number(process.env.WEB_SYNTH_MIN_PATENT_SCORE) || (strict ? 18 : webSearchRecallMode() ? 10 : 14);
  const minWebSoft = Number(process.env.WEB_SYNTH_SOFT_MIN_WEB_SCORE) || (strict ? 18 : corp ? 8 : 12);
  const minPatentSoft = Number(process.env.WEB_SYNTH_SOFT_MIN_PATENT_SCORE) || (strict ? 14 : 8);
  const minSources = Math.min(
    cap,
    Math.max(strict ? 3 : 2, Number(process.env.WEB_SYNTH_MIN_SOURCES) || (corp ? 5 : 4)),
  );

  const rawList = Array.isArray(papers) ? papers : [];
  let arr = rawList.filter((p) => shouldIncludeWebChannelPaper(p, tokens, core, full));
  /** 与 filterWebChannelInclusion 一致：非严格模式下按分数取前列，避免「有摘录但三模型无入参」 */
  if (!strict && !arr.length && rawList.length > 0) {
    arr = rawList
      .map((p) => ({ p, score: scoreWebPaperForAnswer(p, tokens, core, full) }))
      .filter((x) => x.score >= minWebSoft - 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(14, rawList.length))
      .map((x) => x.p);
  }
  const scored = arr
    .map((p) => ({ p, score: scoreWebPaperForAnswer(p, tokens, core, full) }))
    .sort((a, b) => b.score - a.score);

  let webs = scored.filter(
    (x) =>
      isWebPaper(x.p) &&
      /^https?:\/\//i.test(String(x.p.absUrl ?? "").trim()) &&
      x.score >= minWeb,
  );
  let patents = scored.filter((x) => isPatentPaper(x.p) && x.score >= minPatent);

  let maxP = Math.min(6, patents.length);
  let maxW = Math.min(cap - maxP, webs.length, corp ? 22 : 16);
  let picked = [...webs.slice(0, maxW).map((x) => x.p), ...patents.slice(0, maxP).map((x) => x.p)];

  /** 强相关不足：从全量网页/专利中补「弱锚点」摘录（严格模式关闭，避免弱相关进作答） */
  if (!strict && picked.length < minSources) {
    const looseScored = rawList
      .filter(
        (p) =>
          (isWebPaper(p) && /^https?:\/\//i.test(String(p.absUrl ?? "").trim())) || isPatentPaper(p),
      )
      .filter((p) => passesSoftSynthesisAnchor(p, tokens, core, full))
      .map((p) => ({ p, score: scoreWebPaperForAnswer(p, tokens, core, full) }))
      .sort((a, b) => b.score - a.score);

    const seen = new Set(
      picked.map((p) => String(p.absUrl ?? "").trim().split("#")[0] || String(p.paper_id ?? "").trim()),
    );
    const addFrom = (list, minScore, isWeb) => {
      for (const x of list) {
        if (picked.length >= cap) break;
        if (x.score < minScore) continue;
        if (isWeb && !isWebPaper(x.p)) continue;
        if (!isWeb && !isPatentPaper(x.p)) continue;
        const key =
          String(x.p.absUrl ?? "")
            .trim()
            .split("#")[0] || String(x.p.paper_id ?? "").trim();
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(x.p);
      }
    };
    const wLoose = looseScored.filter(
      (x) => isWebPaper(x.p) && /^https?:\/\//i.test(String(x.p.absUrl ?? "").trim()),
    );
    const pLoose = looseScored.filter((x) => isPatentPaper(x.p));
    addFrom(wLoose, minWebSoft, true);
    addFrom(pLoose, minPatentSoft, false);
  }

  /** 仍无摘录时：从全量中取非跑题、带链接的网页/专利按分数兜底（严格模式关闭） */
  if (!strict && !picked.length && rawList.length > 0) {
    const salvage = rawList
      .filter(
        (p) =>
          (isWebPaper(p) && /^https?:\/\//i.test(String(p.absUrl ?? "").trim())) || isPatentPaper(p),
      )
      .filter((p) => !WEB_OFFTOPIC_RE.test(`${p.title || ""} ${p.summary || ""} ${p.abstract || ""}`))
      .filter((p) => {
        const t = `${p.title || ""} ${p.summary || ""}`;
        if (CORPORATE_WEB_INTENT_RE.test(full) && isWebPaper(p) && WEB_TRAVEL_JUNK_RE.test(t)) return false;
        return true;
      })
      .map((p) => ({ p, score: scoreWebPaperForAnswer(p, tokens, core, full) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(minSources, 3), cap, rawList.length))
      .map((x) => x.p);
    if (salvage.length) picked = salvage;
  }

  const scoredFinal = picked.map((p) => ({
    p,
    s: scoreWebPaperForAnswer(p, tokens, core, full),
  }));
  scoredFinal.sort((a, b) => b.s - a.s);
  picked = scoredFinal.map((x) => x.p);

  return {
    papers: picked.slice(0, cap),
    coreQuery: core,
    tokens,
    filteredOut: Math.max(0, rawList.length - picked.length),
    totalIn: rawList.length,
  };
}

/**
 * @param {{ userQuery: string; coreQuery: string; excerptList: string; usedCount: number; totalCount: number; filteredOut: number }} args
 */
export function buildWebAnswerUserPrompt(args) {
  const core = String(args.coreQuery ?? "").trim().slice(0, 800);
  const full = String(args.userQuery ?? "").trim().slice(0, 2500);
  const convo = String(args.conversationContext ?? "").trim().slice(0, 2800);
  const list = String(args.excerptList ?? "").trim().slice(0, 32_000);
  const corpHint = CORPORATE_WEB_INTENT_RE.test(`${core}\n${full}`)
    ? "【意图约束】用户问题涉及**企业 / 产品 / 上市主体 / 主营业务**。若下列摘录主要为城市旅游、景点攻略、娱乐八卦、与城市概况类百科且**未出现**可核对的公司名、股票代码、业务段，则**禁止**据此撰写产品或业务正文；首段须明确「当前摘录与问题类型不匹配」，并逐条列出「未在检索摘录中找到：…」。\n\n"
    : "";
  return (
    corpHint +
    (convo
      ? `【本对话上文（须结合此理解指代与延续话题；勿扩写无关内容）】\n${convo}\n\n`
      : "") +
    `【核心问题】（全文只围绕此问作答，不得扩写无关城市、政府门户、百科概况）\n${core}\n\n` +
    (full && full !== core ? `【用户完整描述】\n${full}\n\n` : "") +
    `【硬性规则】\n` +
    `1. 以摘录为据作答：与核心问题**字面重合较少**、但与**同一技术主题**（材料、工艺、性能、应用、上下游）明显相关的句子，可做**简短合理联想**，须在段内或句末注明「（据 [n] 引申）」；不得写进与核心问题无关的产业八卦、城市宣传、泛百科。\n` +
    `2. 禁止把「仅介绍某地/某政府网站」的摘录写进正文；此类若必须提及，只能放在文末「## 间接参考」且以【间接】开头，每条不超过 2 句。\n` +
    `3. 禁止编造摘录中不存在的公司全称、产品型号、性能数据、标准号、财务数字。\n` +
    `3b. 摘录互相矛盾时，优先采信官网/年报/专利/百科公司条，并在句中说明「以 [n] 为准」。\n` +
    `4. 若摘录未覆盖用户所问要点，请逐条列出「未在检索摘录中找到：…」，不要用无关内容凑篇幅。\n` +
    `5. 关键结论句末标注 [n]（与摘录序号一致）。\n` +
    `6. 联想须**收束回用户问题**；若多条摘录主题分散，优先回答用户最关心的子问题，其余一句带过或标「弱相关」。\n\n` +
    `【版式】请按优质联网问答排版（类似 DeepSeek）：首段定性 → ## 分板块（企业/产品可用 💊🌸🧪 等 emoji 标题）→ 列表写清产品线与应用；每句关键事实带 [n]；不要 JSON、不要元标题「直接回答」。\n\n` +
    `【摘录】\n${list}\n\n` +
    `请输出完整、聚焦的联网综合回答（简体中文）。`
  );
}
