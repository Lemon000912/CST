/**
 * 网页渠道：企业/机构名消歧与多轮检索词（类似 Perplexity：「宁波新合成」→ 浙江新和成 NHU 等）。
 */
import {
  extractCoreSearchQuery,
  extractWebSearchQuery,
  extractConversationContext,
  clampQueryForExternalApi,
} from "./searchQueryNormalize.js";
import { chineseTechnicalFallback } from "./rewrite.js";
import {
  buildBookWebSearchPlan,
  inferBookFollowUpWebQueries,
  isBookIntentQuery,
} from "./bookWebClues.js";

/** @typedef {{ queries: string[]; primary: string; tags: string[] }} WebSearchPlan */

/**
 * 已知易混写：用户输入 → 应并行检索的正式名称/股票代码等。
 * @type {Array<{ test: (raw: string) => boolean; queries: string[]; tag: string }>}
 */
const ENTITY_ALIAS_PACKS = [
  {
    test: (raw) => /宁波\s*新\s*合成|宁波新合成/i.test(raw),
    tag: "entity:宁波新合成→浙江新和成(NHU)",
    /** 优先「官网/主营/产品」类检索，避免首条用「宁波+产品」被搜索引擎当成城市旅游 */
    queries: [
      "浙江新和成股份有限公司 主营业务 产品分类 投资者关系",
      "新和成 002001 NHU 营养品 香精香料 新材料 业务",
      "浙江新和成 官网 产品中心 cnhu",
      "002001 新和成 巨潮资讯 年报 主营业务分产品",
      "东方财富 002001 新和成 公司简介 主营",
      "Zhejiang Xinhecheng NHU stock 002001 products business",
      "浙江新和成 宁波 滨海 产业园 基地 新材料",
      "宁波新合成 新和成 化工 股份",
    ],
  },
  {
    test: (raw) => /新和成|xinhecheng/i.test(raw) && !/宁波\s*新\s*合成|宁波新合成/i.test(raw),
    tag: "entity:新和成/NHU",
    queries: [
      "浙江新和成股份有限公司 002001",
      "NHU 营养品 香精香料 高分子材料",
    ],
  },
  {
    test: (raw) => /宁波新容|王子新材/i.test(raw),
    tag: "entity:宁波新容/王子新材",
    queries: ["宁波新容电器 王子新材 薄膜电容 产品", "王子新材 子公司 宁波新容"],
  },
];

function baseQueryParts(rawQuery, effectiveQuery) {
  const parts = [];
  const eq = String(effectiveQuery ?? "").trim();
  const raw = extractCoreSearchQuery(rawQuery) || String(rawQuery ?? "").trim();
  if (eq) parts.push(eq);
  const codes = raw.match(/\b[A-Z]{2,8}[-_]?\d{2,6}\b/gi) || [];
  for (const c of codes) parts.push(c);
  const zhFb = chineseTechnicalFallback(raw);
  if (zhFb) parts.push(zhFb);
  if (/[\u4e00-\u9fff]/.test(raw) && raw.length <= 160) parts.push(raw);
  return { raw, eq, parts };
}

/**
 * 生成网页渠道第 1 轮并行检索词（含实体消歧）。
 * @param {string} rawQuery
 * @param {string} effectiveQuery
 * @returns {WebSearchPlan}
 */
function pushTopicIntentQueries(pushQ, blob, tags) {
  const b = String(blob ?? "");
  if (/防水|防渗|渗漏/.test(b)) {
    pushQ("防水材料 种类 性能对比 适用");
    pushQ("聚氨酯防水涂料 卷材 SBS 优缺点");
    pushQ("建筑防水 砂浆 沥青 密封材料");
    tags.push("topic:防水材料");
  }
  if (/阻燃|防火|难燃/.test(b)) {
    pushQ("阻燃剂 材料 类型 应用 对比");
    tags.push("topic:阻燃");
  }
  if (/聚氨酯|PU\b|SPU[-_]?\d/i.test(b)) {
    pushQ("聚氨酯材料 性能 应用");
    tags.push("topic:聚氨酯");
  }
  if (/涂料|涂层|油漆/.test(b) && !/防水/.test(b)) {
    pushQ("涂料 种类 性能 应用");
    tags.push("topic:涂料");
  }
  if (/腐蚀|防锈|耐蚀/.test(b)) {
    pushQ("金属材料 耐腐蚀 防护 涂层");
    tags.push("topic:耐蚀");
  }
}

export function buildWebMultiSearchQueries(rawQuery, effectiveQuery, conversationContext) {
  const webRaw = extractWebSearchQuery(rawQuery) || extractCoreSearchQuery(rawQuery) || rawQuery;
  const { raw, eq, parts } = baseQueryParts(webRaw, effectiveQuery);
  const seen = new Set();
  const queries = [];
  const tags = [];

  const pushQ = (q) => {
    const s = clampQueryForExternalApi(String(q ?? "").trim(), 380);
    if (!s || seen.has(s)) return;
    seen.add(s);
    queries.push(s);
  };

  const ctx = String(conversationContext ?? extractConversationContext(rawQuery) ?? "").trim();
  if (ctx) {
    tags.push("ctx:conversation");
    const userLines = [...ctx.matchAll(/用户[：:]\s*([^\n]+)/g)]
      .map((m) => m[1]?.trim())
      .filter(Boolean)
      .slice(-2);
    for (const ul of userLines) {
      pushQ(extractWebSearchQuery(ul) || ul.slice(0, 160));
    }
    const syn = ctx.match(/助手上一[^：:\n]*[：:]\s*([^\n]{16,240})/);
    if (syn?.[1]) {
      pushQ(syn[1].replace(/\s+/g, " ").slice(0, 160));
    }
  }

  /** 书籍问法：优先「书名 + 目录/序言/出版社」多路检索 */
  if (isBookIntentQuery(webRaw) || isBookIntentQuery(raw) || isBookIntentQuery(eq)) {
    const bookPlan = buildBookWebSearchPlan(webRaw, effectiveQuery);
    if (bookPlan.queries.length) {
      tags.push(...bookPlan.tags);
      for (const q of bookPlan.queries) pushQ(q);
    }
  }

  const intentBlob = `${webRaw} ${eq} ${parts.join(" ")}`;
  pushTopicIntentQueries(pushQ, intentBlob, tags);

  /** 命中实体包时：先推「企业/产品」定向检索，再合并改写句，减少「城市名+产品」首条触发旅游 SERP */
  const hitPacks = ENTITY_ALIAS_PACKS.filter((pack) => pack.test(raw) || pack.test(eq) || pack.test(webRaw));
  for (const pack of hitPacks) {
    tags.push(pack.tag);
    for (const q of pack.queries) pushQ(q);
  }

  pushQ(extractWebSearchQuery(raw) || clampQueryForExternalApi(parts.join(" "), 200) || eq || raw.slice(0, 160));

  /** 未命中实体包、但问「某地的公司/产品」：补一条弱化地名的企业向检索 */
  if (!hitPacks.length && /[\u4e00-\u9fff]{2,8}(公司|企业|集团|股份|化工|材料)/.test(raw) && /产品|业务|主营|官网/.test(raw)) {
    pushQ(`${raw} 官网 主营业务`.replace(/\s+/g, " ").trim());
    tags.push("entity:company+主营");
  }

  /** 含「公司/企业/厂家」且较短：补「产品 业务」检索 */
  if (/公司|企业|集团|厂家|股份/.test(raw) && raw.length <= 80) {
    pushQ(`${raw} 产品 业务 应用`);
    tags.push("entity:company+产品");
  }

  const core = parts.join(" ") || eq || raw.slice(0, 200);
  if (core.length >= 4 && queries.length < 14) {
    pushQ(`${core} 官网`);
    pushQ(`${core} 最新`);
  }

  const qCap = Math.min(18, Math.max(6, Number(process.env.WEB_MULTI_QUERY_MAX) || 16));
  return {
    queries: queries.slice(0, qCap),
    primary: queries[0] || raw.slice(0, 200),
    tags,
  };
}

/**
 * 第 1 轮命中后，根据标题/摘要推断第 2 轮检索词（仿 Perplexity 二次搜索）。
 * @param {object[]} papers
 * @param {string} rawQuery
 */
export function inferFollowUpWebQueries(papers, rawQuery) {
  const raw = extractCoreSearchQuery(rawQuery) || String(rawQuery ?? "").trim();
  const bookFollow = inferBookFollowUpWebQueries(papers, raw);
  if (bookFollow.length) return bookFollow;

  const blob = (Array.isArray(papers) ? papers : [])
    .slice(0, 40)
    .map((p) => `${p.title || ""} ${p.summary || ""} ${p.abstract || ""}`)
    .join("\n");
  const out = [];
  const seen = new Set();
  const push = (q) => {
    const s = clampQueryForExternalApi(q, 380);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  if (/宁波\s*新\s*合成|宁波新合成/i.test(raw)) {
    push("002001 新和成 巨潮资讯 年报 主营业务分产品");
    push("浙江新和成股份有限公司 cninfo 投资者关系");
    push("site:cninfo.com.cn 002001 新和成");
    if (/新和成|NHU|002001|浙江新和成/i.test(blob)) {
      push("浙江新和成 营养品 香精香料 新材料 2024 2025");
      push("NHU 002001 主营业务 产品类别");
    }
    if (/新容|王子新材|薄膜电容/i.test(blob)) {
      push("宁波新容 王子新材 电容 产品应用");
    }
    if (/生物科技|生物医药/i.test(blob) && /宁波/.test(blob)) {
      push("宁波新和成生物 产品 API");
    }
  }

  if (/新和成|NHU|002001/i.test(raw)) {
    push("浙江新和成 年报 主营业务 产品");
    push("NHU 002001 东方财富 公司概况");
  }

  if (/新和成|NHU/i.test(blob) && !out.length) {
    push("浙江新和成股份有限公司 产品线 官网");
  }

  const r2Cap = Math.min(8, Math.max(3, Number(process.env.WEB_ROUND2_QUERY_MAX) || 6));
  return out.slice(0, r2Cap);
}

/** 作答相关度：用户写「宁波新合成」时，命中「新和成/NHU」视为同一实体 */
export function webEntityAliasBoost(p, fullQuery) {
  const text = `${p.title || ""} ${p.summary || ""} ${p.abstract || ""}`;
  const raw = String(fullQuery ?? "");
  if (/宁波\s*新\s*合成|宁波新合成/i.test(raw)) {
    if (/浙江新和成|新和成股份|NHU|002001|xinhecheng/i.test(text)) return 95;
    if (/新容|王子新材/.test(text) && /宁波/.test(text)) return 35;
  }
  if (/新合成/.test(raw) && /浙江新和成|NHU|002001/.test(text)) return 60;
  return 0;
}
