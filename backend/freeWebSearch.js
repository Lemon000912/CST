/**
 * 无需注册、无 API Key 的免费全网网页搜索源（HTML/JSON 抓取）。
 * 与 mcpWebSearch.fetchMergedWebPapers 合并使用。
 */
import crypto from "node:crypto";
import { extractDoiCandidate } from "./doi.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 内置公共 SearXNG 实例（可被 SEARXNG_INSTANCES 覆盖） */
const DEFAULT_SEARX_INSTANCES = [
  "https://searx.be",
  "https://search.bus-hit.me",
  "https://searx.tiekoetter.com",
  "https://paulgo.io",
  "https://search.ononoki.org",
  "https://searxng.world",
];

/** 免费源元数据（供状态接口与文档） */
export const FREE_WEB_SEARCH_CATALOG = [
  {
    id: "ddg",
    name: "DuckDuckGo Lite/HTML",
    registration: false,
    apiKey: false,
    note: "默认启用；lite + html 双端点",
  },
  {
    id: "searx",
    name: "SearXNG（公共实例）",
    registration: false,
    apiKey: false,
    note: "聚合多家引擎；实例可能偶发不可用，会自动轮换",
  },
  {
    id: "qwant",
    name: "Qwant Lite",
    registration: false,
    apiKey: false,
    note: "欧洲引擎 lite 页 HTML 解析",
  },
  {
    id: "mojeek",
    name: "Mojeek",
    registration: false,
    apiKey: false,
    note: "独立索引；HTML 解析，偶发限流",
  },
];

export function getFreeWebSourceIds() {
  return FREE_WEB_SEARCH_CATALOG.map((x) => x.id);
}

/** @returns {string[]} */
export function resolveSearxInstances() {
  const raw = String(process.env.SEARXNG_INSTANCES ?? "").trim();
  if (raw) {
    return raw
      .split(/[,;\s]+/)
      .map((u) => u.trim().replace(/\/+$/, ""))
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 12);
  }
  return [...DEFAULT_SEARX_INSTANCES];
}

function stableWebId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 22);
}

function webTimeoutMs(envKey, fallback) {
  return Math.min(28_000, Math.max(5000, Number(process.env[envKey]) || fallback));
}

/** 单源单次 SERP 条数上限（WEB_SOURCE_RESULT_CAP，默认 45） */
export function resolveWebSourceCap(requestedMax, fallback = 16) {
  const env = Number(process.env.WEB_SOURCE_RESULT_CAP);
  const hardMax = Math.min(60, Math.max(20, Number.isFinite(env) && env > 0 ? env : 45));
  const req = Math.max(1, Number(requestedMax) || fallback);
  return Math.min(hardMax, Math.max(req, fallback));
}

/**
 * @param {{ url: string; title: string; description?: string }[]} items
 * @param {string} sourceLabel e.g. searx_web
 */
export function urlItemsToWebPapers(items, sourceLabel, maxPapers = 20) {
  const seen = new Set();
  const papers = [];
  const cap = resolveWebSourceCap(maxPapers, 20);
  for (const it of items) {
    const u = String(it.url ?? "").trim();
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    const desc = String(it.description ?? "");
    const title = String(it.title ?? "").slice(0, 400) || u;
    const doi = extractDoiCandidate(`${u} ${desc}`) || extractDoiCandidate(title);
    const id = stableWebId(u);
    papers.push({
      paper_id: `${sourceLabel}:${id}`,
      doi,
      title,
      abstract: desc.slice(0, 1200),
      year: null,
      venue: venueLabel(sourceLabel),
      oa_status: null,
      authors_json: JSON.stringify([]),
      authors: [],
      summary: String(desc || title).slice(0, 800),
      published: "",
      id,
      absUrl: u,
      pdfUrl: u,
      source: sourceLabel,
      isReferencedByCount: null,
    });
    if (papers.length >= cap) break;
  }
  return papers;
}

function venueLabel(sourceLabel) {
  const m = {
    ddg_web: "Web (DuckDuckGo)",
    searx_web: "Web (SearXNG)",
    qwant_web: "Web (Qwant)",
    mojeek_web: "Web (Mojeek)",
  };
  return m[sourceLabel] || "Web";
}

function parseHtmlLinks(html, max, skipHostRe) {
  const cap = resolveWebSourceCap(max, 12);
  const results = [];
  const seen = new Set();
  const re = /<a[^>]*\shref\s*=\s*["'](https?:\/\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < cap) {
    const href = String(m[1] ?? "").trim();
    if (!href || skipHostRe?.test(href) || seen.has(href)) continue;
    const title = String(m[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 4) continue;
    seen.add(href);
    results.push({ url: href, title: title || href, description: "" });
  }
  return results;
}

/**
 * SearXNG JSON API（公共实例轮换）
 */
export async function fetchSearxWebSearch(query, max) {
  const q = String(query ?? "").trim();
  if (!q) return { papers: [], note: "empty-query", toolName: "searx" };
  const cap = resolveWebSourceCap(max, 12);
  const timeout = webTimeoutMs("SEARXNG_TIMEOUT_MS", 8000);
  const tryN = Math.min(8, Math.max(3, Number(process.env.SEARXNG_INSTANCE_TRY) || 6));
  const instances = resolveSearxInstances().slice(0, tryN);
  const errors = [];
  const mergeInstances = !/^(0|false|off|no)$/i.test(
    String(process.env.WEB_SEARX_MERGE_INSTANCES ?? "1").trim(),
  );

  const tryOne = async (base) => {
    const url = `${base}/search?q=${encodeURIComponent(q)}&format=json&categories=general&language=auto&safesearch=0`;
    const r = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
      timeout,
    );
    if (!r.ok) throw new Error(`${base}:${r.status}`);
    const j = await r.json();
    const rows = Array.isArray(j?.results) ? j.results : [];
    const items = rows
      .map((row) => ({
        url: String(row.url ?? "").trim(),
        title: String(row.title ?? "").trim(),
        description: String(row.content ?? row.description ?? "").trim(),
      }))
      .filter((x) => x.url.startsWith("http"));
    if (!items.length) throw new Error(`${base}:empty`);
    const host = new URL(base).hostname.replace(/\./g, "_");
    return { items, host };
  };

  const settled = await Promise.allSettled(instances.map((base) => tryOne(base)));

  if (mergeInstances) {
    const mergedItems = [];
    const seen = new Set();
    const okHosts = [];
    for (const s of settled) {
      if (s.status !== "fulfilled") {
        errors.push(String(s.reason?.message || s.reason).slice(0, 40));
        continue;
      }
      okHosts.push(s.value.host);
      for (const it of s.value.items) {
        const u = String(it.url ?? "").trim().split("#")[0].toLowerCase();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        mergedItems.push(it);
      }
    }
    if (mergedItems.length) {
      return {
        papers: urlItemsToWebPapers(mergedItems, "searx_web", cap),
        note: `searx_merge:${okHosts.length}inst/${mergedItems.length}`,
        toolName: `searx-${okHosts[0] || "multi"}`,
      };
    }
  } else {
    for (const s of settled) {
      if (s.status === "fulfilled") {
        return {
          papers: urlItemsToWebPapers(s.value.items, "searx_web", cap),
          note: `searx_ok:${s.value.host}`,
          toolName: `searx-${s.value.host}`,
        };
      }
      errors.push(String(s.reason?.message || s.reason).slice(0, 40));
    }
  }

  return { papers: [], note: `searx_fail:${errors.slice(0, 3).join("|")}`, toolName: "searx" };
}

/**
 * Qwant Lite HTML
 */
export async function fetchQwantWebSearch(query, max) {
  const q = String(query ?? "").trim();
  if (!q) return { papers: [], note: "empty-query", toolName: "qwant-lite" };
  const cap = resolveWebSourceCap(max, 12);
  const timeout = webTimeoutMs("QWANT_TIMEOUT_MS", 8000);
  const urls = [
    `https://lite.qwant.com/?q=${encodeURIComponent(q)}&t=web`,
    `https://www.qwant.com/?q=${encodeURIComponent(q)}&t=web`,
  ];
  const skip = /qwant\.com|qwantjunior/i;

  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, { headers: { "User-Agent": UA, Accept: "text/html" } }, timeout);
      if (!r.ok) continue;
      const html = await r.text();
      const items = [];
      const artRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
      let block;
      while ((block = artRe.exec(html)) !== null && items.length < cap) {
        const chunk = block[1];
        const link = chunk.match(/<a[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
        if (!link) continue;
        const href = link[1].trim();
        if (skip.test(href)) continue;
        const title = link[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const descM = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        const description = descM
          ? descM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
          : "";
        items.push({ url: href, title: title || href, description });
      }
      if (!items.length) {
        const fallback = parseHtmlLinks(html, cap, skip);
        items.push(...fallback);
      }
      if (items.length) {
        return {
          papers: urlItemsToWebPapers(items, "qwant_web", cap),
          note: url.includes("lite.") ? "qwant_lite_ok" : "qwant_ok",
          toolName: "qwant-lite",
        };
      }
    } catch (e) {
      console.warn("[qwant_web]", url.slice(0, 40), e?.message);
    }
  }
  return { papers: [], note: "qwant_no_results", toolName: "qwant-lite" };
}

/**
 * Mojeek HTML
 */
export async function fetchMojeekWebSearch(query, max) {
  const q = String(query ?? "").trim();
  if (!q) return { papers: [], note: "empty-query", toolName: "mojeek" };
  const cap = resolveWebSourceCap(max, 12);
  const timeout = webTimeoutMs("MOJEEK_TIMEOUT_MS", 8000);
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`;
  const skip = /mojeek\.com|google\.com|bing\.com/i;

  try {
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": UA, Accept: "text/html" } }, timeout);
    if (!r.ok) return { papers: [], note: `mojeek_http_${r.status}`, toolName: "mojeek" };
    const html = await r.text();
    const items = [];
    const liRe = /<li[^>]*class\s*=\s*["'][^"']*result[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
    let block;
    while ((block = liRe.exec(html)) !== null && items.length < cap) {
      const chunk = block[1];
      const link = chunk.match(/<a[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const href = link[1].trim();
      if (skip.test(href)) continue;
      const title = link[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const descM = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      items.push({
        url: href,
        title: title || href,
        description: descM
          ? descM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
          : "",
      });
    }
    if (!items.length) {
      items.push(...parseHtmlLinks(html, cap, skip));
    }
    if (items.length) {
      return {
        papers: urlItemsToWebPapers(items, "mojeek_web", cap),
        note: "mojeek_ok",
        toolName: "mojeek",
      };
    }
    return { papers: [], note: "mojeek_no_results", toolName: "mojeek" };
  } catch (e) {
    return { papers: [], note: `mojeek_err:${String(e?.message || e).slice(0, 80)}`, toolName: "mojeek" };
  }
}

/** @param {string} sourceId ddg|searx|qwant|mojeek */
export async function fetchFreeWebBySource(sourceId, query, max) {
  switch (sourceId) {
    case "searx":
      return fetchSearxWebSearch(query, max);
    case "qwant":
      return fetchQwantWebSearch(query, max);
    case "mojeek":
      return fetchMojeekWebSearch(query, max);
    case "ddg":
    default:
      return null;
  }
}
