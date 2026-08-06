/**
 * Dataify 网页搜索（Google SERP via scraperapi.dataify.com/request）。
 * 文档：谷歌搜索 API POST https://scraperapi.dataify.com/request（engine=google, 表单 body）。
 * 采集 Builder 见 DATAIFY_SCRAPER_URL / scripts/dataify-first-request.mjs。
 * 旧版 GET api.dataify.com/v1/search 仅当 DATAIFY_LEGACY_SEARCH=1 时启用。
 */

import crypto from "node:crypto";
import { extractDoiCandidate } from "./doi.js";

let dataifyAuthDisabled = false;
let dataifyAuthDisabledKey = "";

export function resetDataifyAuthState() {
  dataifyAuthDisabled = false;
  dataifyAuthDisabledKey = "";
}

function stableWebId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 22);
}

function useLegacyDataifySearch() {
  return /^(1|true|on|yes)$/i.test(String(process.env.DATAIFY_LEGACY_SEARCH ?? "").trim());
}

/** Dataify Google 搜索不接受换行等控制字符，否则会 400 Parameter error */
function sanitizeDataifySearchQuery(query) {
  return String(query ?? "")
    .replace(/\r\n?/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

/** @returns {null | object} */
export function getDataifyWebSearchConfig() {
  const apiKey = String(process.env.DATAIFY_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const timeoutMs = Math.min(60_000, Math.max(3000, Number(process.env.DATAIFY_WEB_TIMEOUT_MS) || 20_000));
  const maxResults = Math.min(50, Math.max(1, Number(process.env.DATAIFY_WEB_MAX_RESULTS) || 20));

  if (useLegacyDataifySearch()) {
    const base = String(process.env.DATAIFY_API_BASE ?? "https://api.dataify.com").trim().replace(/\/+$/, "");
    const path = String(process.env.DATAIFY_WEB_PATH ?? "/v1/search").trim();
    return {
      mode: "legacy",
      apiKey,
      base,
      path: path.startsWith("/") ? path : `/${path}`,
      queryParam: String(process.env.DATAIFY_WEB_QUERY_PARAM ?? "q").trim() || "q",
      timeoutMs,
      maxResults,
      authHeader: String(process.env.DATAIFY_AUTH_HEADER ?? "Authorization").trim() || "Authorization",
      authPrefix:
        process.env.DATAIFY_AUTH_PREFIX !== undefined ? String(process.env.DATAIFY_AUTH_PREFIX) : "Bearer ",
    };
  }

  return {
    mode: "google",
    apiKey,
    requestUrl:
      String(process.env.DATAIFY_REQUEST_URL ?? "").trim() ||
      "https://scraperapi.dataify.com/request",
    googleDomain: String(process.env.DATAIFY_GOOGLE_DOMAIN ?? "google.com").trim() || "google.com",
    hl: String(process.env.DATAIFY_GOOGLE_HL ?? "zh-cn").trim() || "zh-cn",
    gl: String(process.env.DATAIFY_GOOGLE_GL ?? "cn").trim() || "cn",
    cr: String(process.env.DATAIFY_GOOGLE_CR ?? "").trim(),
    lr: String(process.env.DATAIFY_GOOGLE_LR ?? "").trim(),
    json: String(process.env.DATAIFY_GOOGLE_JSON ?? "1").trim() || "1",
    timeoutMs,
    maxResults,
  };
}

/** @param {unknown} obj @param {Array<{url:string,title:string,description:string}>} out */
function collectUrlResults(obj, out, depth) {
  if (depth > 14 || obj == null) return;
  if (Array.isArray(obj)) {
    for (const x of obj) collectUrlResults(x, out, depth + 1);
    return;
  }
  if (typeof obj !== "object") return;
  const o = /** @type {Record<string, unknown>} */ (obj);
  const url = o.url ?? o.URL ?? o.href ?? o.link ?? o.uri;
  const title = o.title ?? o.name ?? o.heading ?? "";
  const desc = o.description ?? o.snippet ?? o.body ?? o.summary ?? o.text ?? "";
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    out.push({
      url: url.split("#")[0],
      title: String(title || "Web").slice(0, 400),
      description: String(desc).slice(0, 1200),
    });
  }
  for (const k of Object.keys(o)) collectUrlResults(o[k], out, depth + 1);
}

function unwrapDataifyPayload(body) {
  if (body == null || typeof body !== "object") return body;
  const o = /** @type {Record<string, unknown>} */ (body);
  const code = o.code;
  if (code !== undefined && code !== null && code !== 0 && code !== 200) {
    return null;
  }
  if (o.success === false) return null;
  if (o.data !== undefined) return o.data;
  if (o.result !== undefined) return o.result;
  return o;
}

/**
 * @param {unknown[]} organic
 * @param {number} max
 */
function organicToPapers(organic, max) {
  const papers = [];
  const seen = new Set();
  for (const item of organic) {
    if (!item || typeof item !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    const u = String(o.link ?? o.url ?? "").trim();
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    const title = String(o.title ?? o.source ?? "Web").slice(0, 400);
    const summary = String(o.description ?? o.snippet ?? o.display_link ?? title).slice(0, 1200);
    const doi = extractDoiCandidate(`${u} ${summary}`) || extractDoiCandidate(title);
    const id = stableWebId(u);
    papers.push({
      paper_id: `dataify_web:${id}`,
      doi,
      title,
      abstract: summary,
      year: null,
      venue: "Web (Dataify Google)",
      oa_status: null,
      authors_json: JSON.stringify([]),
      authors: [],
      summary,
      published: "",
      id,
      absUrl: u,
      pdfUrl: u,
      source: "dataify_web",
      isReferencedByCount: null,
    });
    if (papers.length >= max) break;
  }
  return papers;
}

function jsonToWebPapers(json, max, sourceLabel) {
  const root = /** @type {Record<string, unknown>} */ (json);
  if (Array.isArray(root.organic) && root.organic.length) {
    return organicToPapers(root.organic, max);
  }

  const rawItems = [];
  const unwrapped = unwrapDataifyPayload(json);
  if (unwrapped != null) collectUrlResults(unwrapped, rawItems, 0);
  else collectUrlResults(json, rawItems, 0);

  const seen = new Set();
  const papers = [];
  for (const it of rawItems) {
    const u = String(it.url || "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const doi = extractDoiCandidate(`${u} ${it.description}`) || extractDoiCandidate(it.title);
    const id = stableWebId(u);
    const summary = it.description || it.title;
    papers.push({
      paper_id: `${sourceLabel}:${id}`,
      doi,
      title: it.title || u,
      abstract: summary,
      year: null,
      venue: "Web (Dataify)",
      oa_status: null,
      authors_json: JSON.stringify([]),
      authors: [],
      summary,
      published: "",
      id,
      absUrl: u,
      pdfUrl: u,
      source: sourceLabel,
      isReferencedByCount: null,
    });
    if (papers.length >= max) break;
  }
  return papers;
}

/**
 * @param {NonNullable<ReturnType<typeof getDataifyWebSearchConfig>>} cfg
 * @param {string} query
 * @param {number} cap
 */
async function fetchDataifyGoogleSearch(cfg, query, cap) {
  const q = sanitizeDataifySearchQuery(query);
  if (!q) {
    return { papers: [], note: "empty-query", toolName: "dataify-google" };
  }
  const params = new URLSearchParams({
    engine: "google",
    q,
    google_domain: cfg.googleDomain,
    json: cfg.json,
    num: String(Math.min(50, Math.max(1, cap))),
  });
  if (cfg.hl) params.set("hl", cfg.hl);
  if (cfg.gl) params.set("gl", cfg.gl);
  if (cfg.cr) params.set("cr", cfg.cr);
  if (cfg.lr) params.set("lr", cfg.lr);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        token: cfg.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "QuantumPinnacle/1.0",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn("[dataify_web] HTTP", res.status, text.slice(0, 240));
      if (res.status === 401 || res.status === 403) {
        dataifyAuthDisabled = true;
        dataifyAuthDisabledKey = cfg.apiKey;
      }
      return { papers: [], note: `http_${res.status}`, toolName: "dataify-google" };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { papers: [], note: "non-json", toolName: "dataify-google" };
    }
    const code = /** @type {{ code?: unknown; message?: string; data?: unknown }} */ (json).code;
    if (typeof code === "number" && code !== 200 && code !== 0) {
      const msg = String(/** @type {{ message?: string }} */ (json).message ?? json.data ?? "").slice(0, 120);
      console.warn("[dataify_web] google api code:", code, msg, "q:", q.slice(0, 80));
      if (code === 401 || code === 403) {
        dataifyAuthDisabled = true;
        dataifyAuthDisabledKey = cfg.apiKey;
      }
      return { papers: [], note: `api_code:${code}`, toolName: "dataify-google" };
    }
    const papers = jsonToWebPapers(json, cap, "dataify_web");
    return {
      papers,
      note: papers.length ? `google_ok(${papers.length})` : "google_empty",
      toolName: "dataify-google",
    };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 120);
    console.warn("[dataify_web] google fetch failed:", msg);
    return { papers: [], note: `err:${msg}`, toolName: "dataify-google" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {NonNullable<ReturnType<typeof getDataifyWebSearchConfig>>} cfg
 * @param {string} query
 * @param {number} cap
 */
async function fetchDataifyLegacySearch(cfg, query, cap) {
  const u = new URL(cfg.path, cfg.base.endsWith("/") ? cfg.base : `${cfg.base}/`);
  u.searchParams.set(cfg.queryParam, query.slice(0, 2000));
  const headers = {
    Accept: "application/json",
    "User-Agent": "QuantumPinnacle/1.0",
  };
  const authValue = cfg.authPrefix ? `${cfg.authPrefix}${cfg.apiKey}` : cfg.apiKey;
  headers[cfg.authHeader] = authValue;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(u.toString(), { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        dataifyAuthDisabled = true;
        dataifyAuthDisabledKey = cfg.apiKey;
      }
      return { papers: [], note: `http_${res.status}`, toolName: "dataify" };
    }
    const json = JSON.parse(text);
    const c = json?.code;
    if (typeof c === "number" && c !== 0 && c !== 200) {
      return { papers: [], note: `api_code:${c}`, toolName: "dataify" };
    }
    const papers = jsonToWebPapers(json, cap, "dataify_web");
    return { papers, note: papers.length ? "ok" : "no-url-results", toolName: "dataify" };
  } catch (e) {
    return { papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, toolName: "dataify" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} query
 * @param {number} max
 * @returns {Promise<{ papers: object[]; note: string; toolName?: string }>}
 */
export async function fetchDataifyWebPapers(query, max) {
  const cfg = getDataifyWebSearchConfig();
  if (!cfg) return { papers: [], note: "disabled" };
  if (dataifyAuthDisabled && dataifyAuthDisabledKey === cfg.apiKey) {
    return { papers: [], note: "auth_disabled" };
  }
  if (dataifyAuthDisabledKey && dataifyAuthDisabledKey !== cfg.apiKey) {
    resetDataifyAuthState();
  }

  const q = sanitizeDataifySearchQuery(query);
  if (!q) return { papers: [], note: "empty-query" };

  const cap = Math.min(max || 15, cfg.maxResults);
  if (cfg.mode === "google") {
    return fetchDataifyGoogleSearch(cfg, q, cap);
  }
  return fetchDataifyLegacySearch(cfg, q, cap);
}
