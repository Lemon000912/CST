/**
 * Tavily Search API（可选）：配置 TAVILY_API_KEY 后并入「网页」渠道。
 * 官方文档：POST https://api.tavily.com/search
 * MCP 链接（https://mcp.tavily.com/mcp/?tavilyApiKey=…）仅用于提取 Key；本后端走 REST，不连远程 MCP SSE。
 */

import crypto from "node:crypto";
import { extractDoiCandidate } from "./doi.js";

/** 鉴权失败后本会话内不再重复请求 */
let tavilyAuthDisabled = false;

function stableWebId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 22);
}

/** 从 TAVILY_MCP_URL 查询参数解析 Key */
function apiKeyFromMcpUrl() {
  const raw = String(process.env.TAVILY_MCP_URL ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return (
      u.searchParams.get("tavilyApiKey") ||
      u.searchParams.get("api_key") ||
      u.searchParams.get("key") ||
      ""
    ).trim();
  } catch {
    return "";
  }
}

export function resolveTavilyApiKey() {
  const direct = String(process.env.TAVILY_API_KEY ?? "").trim();
  if (direct) return direct;
  return apiKeyFromMcpUrl();
}

/** @returns {null | { apiKey: string, searchUrl: string, timeoutMs: number, maxResults: number, searchDepth: string }} */
export function getTavilyWebSearchConfig() {
  const apiKey = resolveTavilyApiKey();
  if (!apiKey) return null;

  const base = String(process.env.TAVILY_API_BASE ?? "https://api.tavily.com").trim().replace(/\/+$/, "");
  const path = String(process.env.TAVILY_WEB_PATH ?? "/search").trim();
  const pathNorm = path.startsWith("/") ? path : `/${path}`;
  const searchUrl = `${base}${pathNorm}`;
  const timeoutMs = Math.min(60_000, Math.max(3000, Number(process.env.TAVILY_WEB_TIMEOUT_MS) || 20_000));
  const maxResults = Math.min(20, Math.max(1, Number(process.env.TAVILY_WEB_MAX_RESULTS) || 15));
  const searchDepth = String(process.env.TAVILY_SEARCH_DEPTH ?? "basic").trim() || "basic";

  return { apiKey, searchUrl, timeoutMs, maxResults, searchDepth };
}

/**
 * @param {unknown} json
 * @param {number} max
 */
function tavilyJsonToPapers(json, max) {
  const papers = [];
  const seen = new Set();
  const root = json && typeof json === "object" ? /** @type {Record<string, unknown>} */ (json) : {};
  const list = Array.isArray(root.results) ? root.results : [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    const u = String(o.url ?? o.link ?? "").trim();
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    const title = String(o.title ?? "Web").slice(0, 400);
    const summary = String(o.content ?? o.snippet ?? o.description ?? title).slice(0, 1200);
    const doi = extractDoiCandidate(`${u} ${summary}`) || extractDoiCandidate(title);
    const id = stableWebId(u);
    papers.push({
      paper_id: `tavily_web:${id}`,
      doi,
      title,
      abstract: summary,
      year: null,
      venue: "Web (Tavily)",
      oa_status: null,
      authors_json: JSON.stringify([]),
      authors: [],
      summary,
      published: "",
      id,
      absUrl: u,
      pdfUrl: u,
      source: "tavily_web",
      isReferencedByCount: null,
    });
    if (papers.length >= max) break;
  }
  return papers;
}

/**
 * @param {string} query
 * @param {number} max
 * @returns {Promise<{ papers: object[]; note: string; toolName?: string }>}
 */
export async function fetchTavilyWebPapers(query, max) {
  if (tavilyAuthDisabled) return { papers: [], note: "auth_disabled" };

  const cfg = getTavilyWebSearchConfig();
  if (!cfg) return { papers: [], note: "disabled" };

  const q = String(query ?? "").trim();
  if (!q) return { papers: [], note: "empty-query" };

  const cap = Math.min(max || 15, cfg.maxResults);
  const body = {
    query: q.slice(0, 400),
    max_results: cap,
    search_depth: cfg.searchDepth,
    include_answer: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn("[tavily_web] HTTP", res.status, text.slice(0, 240));
      if (res.status === 401 || res.status === 403) tavilyAuthDisabled = true;
      return { papers: [], note: `http_${res.status}`, toolName: "tavily" };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { papers: [], note: "non-json", toolName: "tavily" };
    }
    const papers = tavilyJsonToPapers(json, cap);
    return {
      papers,
      note: papers.length ? "ok" : "no-results",
      toolName: "tavily",
    };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 120);
    console.warn("[tavily_web] fetch failed:", msg);
    return { papers: [], note: `err:${msg}`, toolName: "tavily" };
  } finally {
    clearTimeout(timer);
  }
}
