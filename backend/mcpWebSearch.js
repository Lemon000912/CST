/**
 * 可选：通过 MCP（stdio 子进程）拉取网页搜索结果，并入「网页」渠道。
 *
 * 环境变量（均在服务端，勿提交密钥）：
 * - MCP_WEB_COMMAND：可执行文件，如 npx（Windows 上常为 npx.cmd）
 * - MCP_WEB_ARGS_JSON：参数 JSON 数组，如 ["-y","@modelcontextprotocol/server-brave-search"]
 * - MCP_WEB_TOOL：工具名；留空则优先匹配包含 "search" 或 "brave" 的工具名
 * - MCP_WEB_QUERY_ARG：传给工具的查询字段名，默认 query
 * - MCP_WEB_TOOL_ARGS_JSON：与查询合并的额外 JSON 对象（如 {"count":5}）
 * - MCP_WEB_MAX_RESULTS：条数上限，默认 8
 * - MCP_WEB_TIMEOUT_MS：整次 MCP 调用超时，默认 60000（首次 npx -y 拉包可能较慢，可设 90000+）
 * - MCP_WEB_ATTEMPTS：连接/调用失败时的重试次数（含瞬断 -32000），默认 3，范围 1～5
 * - MCP_WEB_ENV_JSON：合并进子进程 env 的 JSON（也可用系统环境变量如 BRAVE_API_KEY）
 *
 * 排错：Brave 官方包须有效 BRAVE_API_KEY；Windows 用 npx.cmd；看运行 npm run dev:server 的终端里子进程 stderr。
 *
 * 备用方案：未配置 MCP/Brave 时自动退回 DuckDuckGo Lite 免费网页搜索。
 */

import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractDoiCandidate } from "./doi.js";
import { extractPatentNumberFromPaper } from "./patentNumber.js";
import { fetchDataifyWebPapers, getDataifyWebSearchConfig } from "./dataifyWebSearch.js";
import { fetchTavilyWebPapers, getTavilyWebSearchConfig } from "./tavilyWebSearch.js";
import { fetchWikipediaWebPapers, getWikipediaSearchConfig } from "./wikipediaSearch.js";
import { fetchCoreWebPapers, getCoreSearchConfig } from "./coreSearch.js";
import {
  FREE_WEB_SEARCH_CATALOG,
  fetchSearxWebSearch,
  fetchQwantWebSearch,
  fetchMojeekWebSearch,
  resolveWebSourceCap,
  getFreeWebSourceIds,
} from "./freeWebSearch.js";
import { traceAsync } from "./performanceTrace.js";

export { FREE_WEB_SEARCH_CATALOG, getFreeWebSourceIds };

/** 是否启用 Bing HTML 爬取（默认关闭，使用 Dataify / Brave MCP / DuckDuckGo） */
export function isBingWebEnabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.WEB_USE_BING ?? "").trim());
}

/**
 * 免费源均失败时回退 cn.bing.com（国内网络常无法访问 DDG/SearX，默认可用）
 * 设 WEB_CN_BING_FALLBACK=0 可关闭
 */
export function isCnBingFallbackEnabled() {
  return !/^(0|false|off|no)$/i.test(String(process.env.WEB_CN_BING_FALLBACK ?? "1").trim());
}

/**
 * 允许参与「全网合并」的源：
 * 免费（默认）：ddg, searx, qwant, mojeek
 * 需 Key：core, tavily, mcp
 * 可选：bing（须 WEB_USE_BING=1）
 * @returns {Set<string>}
 */
export function getWebSourceAllowlist() {
  // 保留原通用网页检索，并叠加 Wikipedia 与 CORE；Semantic Scholar 仍由数据库渠道负责。
  const defaultFree = "tavily,dataify,searx,wikipedia,core";
  const raw = String(process.env.WEB_SOURCES ?? defaultFree).trim().toLowerCase();
  const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const set = new Set(parts.length ? parts : ["tavily", "dataify", "searx", "wikipedia", "core"]);
  if (isBingWebEnabled()) set.add("bing");
  else set.delete("bing");
  return set;
}

/** @returns {Record<string, boolean>} */
export function getWebSourcesStatus() {
  const allow = getWebSourceAllowlist();
  return {
    ddg: allow.has("ddg"),
    searx: allow.has("searx"),
    qwant: allow.has("qwant"),
    mojeek: allow.has("mojeek"),
    dataify: allow.has("dataify") && Boolean(getDataifyWebSearchConfig()),
    tavily: allow.has("tavily") && Boolean(getTavilyWebSearchConfig()),
    wikipedia: allow.has("wikipedia") && Boolean(getWikipediaSearchConfig()),
    core: allow.has("core") && Boolean(getCoreSearchConfig()),
    mcp: allow.has("mcp") && isMcpUsable(),
    bing: allow.has("bing") && isBingWebEnabled(),
  };
}

/** Linux 上 .env 若仍为 npx.cmd 会导致 MCP 子进程启动失败 */
function resolveMcpSpawnCommand(command) {
  let cmd = String(command ?? "").trim();
  if (!cmd) return "";
  if (process.platform !== "win32") {
    if (/npx\.cmd$/i.test(cmd) || cmd.toLowerCase() === "npx.cmd") cmd = "npx";
    else if (/\.cmd$/i.test(cmd)) cmd = cmd.replace(/\.cmd$/i, "");
  }
  return cmd;
}

/** @returns {null | { command: string, args: string[], env: Record<string,string>, toolHint: string, queryArg: string, maxResults: number, timeoutMs: number, connectAttempts: number, toolExtra: Record<string, unknown> }} */
export function getMcpWebSearchConfig() {
  const command = resolveMcpSpawnCommand(process.env.MCP_WEB_COMMAND ?? "");
  if (!command) return null;

  let args = [];
  try {
    const raw = String(process.env.MCP_WEB_ARGS_JSON ?? "[]").trim();
    const j = JSON.parse(raw);
    if (Array.isArray(j)) args = j.map(String);
  } catch {
    args = [];
  }

  let extraEnv = {};
  try {
    const er = String(process.env.MCP_WEB_ENV_JSON ?? "").trim();
    if (er) {
      const o = JSON.parse(er);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            extraEnv[String(k)] = String(v);
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  let toolExtra = {};
  try {
    const tr = String(process.env.MCP_WEB_TOOL_ARGS_JSON ?? "").trim();
    if (tr) {
      const o = JSON.parse(tr);
      if (o && typeof o === "object" && !Array.isArray(o)) toolExtra = o;
    }
  } catch {
    toolExtra = {};
  }

  const toolHint = String(process.env.MCP_WEB_TOOL ?? "").trim();
  const queryArg = String(process.env.MCP_WEB_QUERY_ARG ?? "query").trim() || "query";
  const maxResults = Math.min(50, Math.max(1, Number(process.env.MCP_WEB_MAX_RESULTS) || 24));
  const timeoutMs = Math.min(120_000, Math.max(5000, Number(process.env.MCP_WEB_TIMEOUT_MS) || 60_000));
  const connectAttempts = Math.min(
    5,
    Math.max(1, (() => {
      const n = Number(process.env.MCP_WEB_ATTEMPTS);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
    })()),
  );

  return {
    command,
    args,
    env: { ...process.env, ...extraEnv },
    toolHint,
    queryArg,
    maxResults,
    timeoutMs,
    connectAttempts,
    toolExtra,
  };
}

function stableWebId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 22);
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

/** @param {unknown} result */
function papersFromToolResult(result, max) {
  const rawItems = [];
  if (!result || typeof result !== "object") return [];
  const sc = /** @type {{ structuredContent?: unknown }} */ (result).structuredContent;
  if (sc && typeof sc === "object") collectUrlResults(sc, rawItems, 0);

  const texts = [];
  for (const c of result?.content ?? []) {
    if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
  }
  const joined = texts.join("\n");
  if (joined) {
    try {
      const j = JSON.parse(joined);
      collectUrlResults(j, rawItems, 0);
    } catch {
      try {
        const re = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
        let m;
        while ((m = re.exec(joined))) {
          rawItems.push({ url: m[1], title: "Link", description: joined.slice(0, 400) });
        }
      } catch {
        /* ignore */
      }
    }
  }

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
      paper_id: `mcpweb:${id}`,
      doi,
      title: it.title || u,
      abstract: summary,
      year: null,
      venue: "Web (MCP)",
      oa_status: null,
      authors_json: JSON.stringify([]),
      authors: [],
      summary,
      published: "",
      id,
      absUrl: u,
      pdfUrl: u,
      source: "mcp_web",
      isReferencedByCount: null,
    });
    if (papers.length >= max) break;
  }
  return papers;
}

/** @param {{ name: string }[]} tools @param {string} hint */
function pickToolName(tools, hint) {
  if (!tools?.length) return null;
  if (hint) {
    const exact = tools.find((t) => t.name === hint);
    if (exact) return exact.name;
    const partial = tools.find((t) => t.name.includes(hint));
    if (partial) return partial.name;
  }
  const bySearch = tools.find((t) => /search/i.test(t.name));
  if (bySearch) return bySearch.name;
  const brave = tools.find((t) => /brave/i.test(t.name));
  if (brave) return brave.name;
  return tools[0]?.name ?? null;
}

/**
 * @param {string} query
 * @param {number} max
 * @returns {Promise<{ papers: object[]; note: string; toolName?: string }>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** MCP 子进程偶发 JSON-RPC Connection closed（-32000），重连常可恢复 */
function isMcpTransientDisconnect(err) {
  const s = `${err?.message || err?.code || err || ""}`;
  return /connection closed|-32000|ECONNRESET|EPIPE|socket hang up/i.test(s);
}

/** Brave Search 官方 MCP 包需要 BRAVE_API_KEY */
function argsLookLikeBraveSearch(args) {
  const j = args.join("\0").toLowerCase();
  return j.includes("server-brave-search") || j.includes("brave-search");
}

function braveApiKeyPresent(env) {
  const k = env?.BRAVE_API_KEY ?? process.env.BRAVE_API_KEY;
  return typeof k === "string" && k.trim().length > 0;
}

export function isMcpUsable() {
  var cfg = getMcpWebSearchConfig();
  if (!cfg) return false;
  if (argsLookLikeBraveSearch(cfg.args) && !braveApiKeyPresent(cfg.env)) return false;
  return true;
}

export async function fetchMcpWebPapers(query, max) {
  const cfg = getMcpWebSearchConfig();
  if (!cfg) return { papers: [], note: "disabled" };

  const q = String(query ?? "").trim();
  if (!q) return { papers: [], note: "empty-query" };

  if (argsLookLikeBraveSearch(cfg.args) && !braveApiKeyPresent(cfg.env)) {
    /** 与未配置 MCP 一致：静默跳过，避免在「数据源」里刷 Brave 提示 */
    return { papers: [], note: "disabled" };
  }

  const maxAttempts = cfg.connectAttempts;
  let lastNote = "err:unknown";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    });
    const client = new Client({ name: "quantum-pinnacle", version: "1.0.0" }, { capabilities: {} });

    const run = async () => {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = listed?.tools ?? [];
      const toolName = pickToolName(tools, cfg.toolHint);
      if (!toolName) {
        return { papers: [], note: "no-tools", toolName: null };
      }
      const args = {
        ...cfg.toolExtra,
        [cfg.queryArg]: q.slice(0, 2000),
      };
      if (cfg.toolExtra.count == null && cfg.toolExtra.limit == null) {
        args.count = Math.min(max, cfg.maxResults);
      }
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      if (result?.isError) {
        const msg = result.content?.map((c) => (c.type === "text" ? c.text : "")).join(" | ");
        return { papers: [], note: `tool-error:${(msg || "unknown").slice(0, 120)}`, toolName };
      }
      const papers = papersFromToolResult(result, Math.min(max, cfg.maxResults));
      return { papers, note: papers.length ? "ok" : "no-url-results", toolName };
    };

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("mcp_timeout")), cfg.timeoutMs);
    });

    try {
      const out = await Promise.race([run(), timeout]);
      clearTimeout(timeoutId);
      await client.close().catch(() => {});
      return out;
    } catch (e) {
      clearTimeout(timeoutId);
      await client.close().catch(() => {});
      const msg = e?.message || String(e);
      lastNote = msg.includes("mcp_timeout") ? "timeout" : `err:${msg.slice(0, 120)}`;
      if (attempt < maxAttempts - 1 && isMcpTransientDisconnect(e)) {
        const backoff = 700 + attempt * 550;
        console.warn(`[mcp_web] transient disconnect (attempt ${attempt + 1}/${maxAttempts}), retry in ${backoff}ms`, msg);
        await sleep(backoff);
        continue;
      }
      return { papers: [], note: lastNote };
    }
  }

  return { papers: [], note: lastNote };
}

var _ddgUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DDG_URLS = [
  "https://lite.duckduckgo.com/lite/",
  "https://html.duckduckgo.com/html/",
];

function _ddgFetchOne(url, query, timeoutMs) {
  const fullUrl = url + "?q=" + encodeURIComponent(query);
  var ua = typeof process !== "undefined" ? String(process.env?.DDG_USER_AGENT || _ddgUA || "Mozilla/5.0").trim() : _ddgUA;
  if (!ua) ua = "Mozilla/5.0 (compatible; QuantumPinnacle/1.0)";
  var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 8000) : null;
  var opts = { headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml" } };
  if (controller) opts.signal = controller.signal;
  return fetch(fullUrl, opts).then(function (r) {
    if (timer) clearTimeout(timer);
    if (!r.ok) throw new Error("DDG HTTP " + r.status);
    return r.text();
  });
}

function ddgTimeoutMs() {
  return Math.min(25_000, Math.max(4000, Number(process.env.DDG_WEB_TIMEOUT_MS) || 12_000));
}

function bingTimeoutMs() {
  return Math.min(35_000, Math.max(8000, Number(process.env.BING_WEB_TIMEOUT_MS) || 22_000));
}

function _ddgFetch(query) {
  const t = ddgTimeoutMs();
  return DDG_URLS.reduce(function (chain, url) {
    return chain.catch(function () {
      return _ddgFetchOne(url, query, t);
    });
  }, Promise.reject(new Error("no-dd-endpoints")));
}

/** 从 Bing 新版 HTML（含 cn.bing.com）抽取结果链接 */
function _bingParseResultsHtml(html, max) {
  const cap = resolveWebSourceCap(max, 12);
  const results = [];
  const seen = new Set();
  const skipHost =
    /(?:bing\.com|microsoft\.com|msn\.com|live\.com|office\.com|google\.com\/search|miit\.gov\.cn|beian\.)/i;

  /** 当前 SERP 主结果多在 h2 > a */
  const h2Re = /<h2[^>]*>[\s\S]*?<a[^>]*\shref\s*=\s*["'](https?:\/\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let hm;
  while ((hm = h2Re.exec(html)) !== null && results.length < cap) {
    const href = String(hm[1] ?? "").trim();
    if (!href || skipHost.test(href) || seen.has(href)) continue;
    const title = String(hm[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 4) continue;
    if (/^(增值电信|京ICP|经营许可证)/.test(title)) continue;
    seen.add(href);
    results.push({ url: href, title: title || href, description: "" });
  }
  if (results.length >= Math.min(4, cap)) return results.slice(0, cap);

  const blockRe = /<li[^>]*\bb_algo\b[^>]*>[\s\S]*?<\/li>/gi;
  let block;
  while ((block = blockRe.exec(html)) !== null && results.length < cap) {
    const chunk = block[0];
    const linkRe =
      /<a[^>]*\shref\s*=\s*["'](https?:\/\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    let best = null;
    while ((m = linkRe.exec(chunk)) !== null) {
      const href = String(m[1] ?? "").trim();
      if (!href || skipHost.test(href)) continue;
      const title = String(m[2] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!best || title.length > (best.title?.length ?? 0)) {
        best = { url: href, title: title || href, description: "" };
      }
    }
    if (best && !seen.has(best.url)) {
      seen.add(best.url);
      const descM = chunk.match(/<p[^>]*class\s*=\s*["'][^"']*b_lineclamp[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
      if (descM) {
        best.description = String(descM[1])
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 600);
      }
      results.push(best);
    }
  }

  if (results.length < cap) {
    const fallbackRe =
      /<a[^>]*\shref\s*=\s*["'](https?:\/\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = fallbackRe.exec(html)) !== null && results.length < cap) {
      const href = String(m[1] ?? "").trim();
      if (!href || skipHost.test(href) || seen.has(href)) continue;
      const title = String(m[2] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (title.length < 4) continue;
      seen.add(href);
      results.push({ url: href, title: title || href, description: "" });
    }
  }
  return results.slice(0, cap);
}

/**
 * Bing 网页检索（国内网络常无法访问 DuckDuckGo，优先 cn.bing.com）
 * @param {string} query
 * @param {number} max
 */
export async function fetchBingWebSearch(query, max, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { papers: [], note: "empty-query", toolName: "bing-cn" };
  const cap = resolveWebSourceCap(max, 12);
  const cnOnly = opts.cnOnly === true;
  const urls = cnOnly
    ? [`https://cn.bing.com/search?q=${encodeURIComponent(q)}&ensearch=0`]
    : [
        `https://cn.bing.com/search?q=${encodeURIComponent(q)}&ensearch=0`,
        `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
      ];
  const timeout = bingTimeoutMs();
  for (const url of urls) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": _ddgUA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: controller?.signal,
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 400) continue;
      const items = _bingParseResultsHtml(html, cap);
      if (items.length) {
        return {
          papers: _ddgToPapers(items, "ddg_web", cap),
          note: url.includes("cn.bing") ? "bing_cn_ok" : "bing_com_ok",
          toolName: url.includes("cn.bing") ? "bing-cn" : "bing-com",
        };
      }
    } catch (e) {
      if (timer) clearTimeout(timer);
      console.warn("[bing_web]", url.slice(0, 40), e?.message);
    }
  }
  return { papers: [], note: "bing_no_results", toolName: "bing-cn" };
}

function _ddgParseResults(html, max) {
  var results = [];
  var re = /<a[^>]*\srel\s*=\s*["']?\w*\s*nofollow\w*["']?[^>]*\sclass\s*=\s*["'](?:result-link|result-snippet)["']?[^>]*\shref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var url = match[1];
    var text = match[2].replace(/<[^>]+>/g, "").trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (results.length >= max) break;
    var isNew = !results.some(function (r) { return r.url === url; });
    if (isNew) {
      results.push({ url: url, title: text || url, description: "" });
    }
  }
  var snipRe = /<td[^>]*class\s*=\s*["']?(?:result-snippet)?["']?[^>]*>([\s\S]*?)<\/td>/gi;
  var idx = 0;
  while ((match = snipRe.exec(html)) !== null && idx < max) {
    var snippet = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (snippet && idx < results.length) {
      results[idx].description = snippet.slice(0, 600);
    }
    idx++;
  }
  if (results.length === 0) {
    var altRe = /<a[^>]*\shref\s*=\s*["'](\/\/duckduckgo\.com\/l\/\?uddg=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = altRe.exec(html)) !== null) {
      var raw = match[1];
      try {
        var params = new URL(raw, "https://lite.duckduckgo.com").searchParams;
        var realUrl = params.get("uddg") || raw;
      } catch (e) {
        realUrl = raw;
      }
      var decoded = "";
      try { decoded = decodeURIComponent(realUrl); } catch (e) { decoded = realUrl; }
      if (!/^https?:\/\//i.test(decoded)) continue;
      var title = match[2].replace(/<[^>]+>/g, "").trim();
      results.push({ url: decoded, title: title || decoded, description: "" });
      if (results.length >= max) break;
    }
  }
  return results.slice(0, max);
}

function _ddgToPapers(items, sourceLabel, maxPapers = 20) {
  var seen = new Set();
  var papers = [];
  const cap = resolveWebSourceCap(maxPapers, 20);
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var u = String(it.url || "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    var desc = String(it.description || "");
    var title = String(it.title || "").slice(0, 400) || u;
    var doi =
      sourceLabel === "ddg_patent"
        ? null
        : extractDoiCandidate(u + " " + desc) || extractDoiCandidate(title);
    var id = stableWebId(u);
    var row = {
      paper_id: sourceLabel + ":" + id,
      doi: doi,
      title: title,
      abstract: desc.slice(0, 1200),
      year: null,
      venue: sourceLabel === "ddg_patent" ? "Patent (Web)" : "Web (DDG)",
      oa_status: null,
      authors_json: JSON.stringify([]),
      authors: [],
      summary: String(desc || title || "").slice(0, 800),
      published: "",
      id: id,
      absUrl: u,
      pdfUrl: u,
      source: sourceLabel,
      isReferencedByCount: null,
    };
    if (sourceLabel === "ddg_patent") {
      var pn = extractPatentNumberFromPaper(row);
      if (pn) row.patentNumber = pn;
    }
    papers.push(row);
    if (papers.length >= cap) break;
  }
  return papers;
}

/** 合并去重时优先保留高质量源（CORE > Tavily > Dataify > Wikipedia > SearX > MCP > …） */
const WEB_MERGE_SOURCE_RANK = {
  core: 1,
  tavily_web: 2,
  dataify_web: 3,
  wikipedia_web: 4,
  searx_web: 5,
  mcp_web: 6,
  qwant_web: 7,
  mojeek_web: 8,
  ddg_patent: 7,
  ddg_web: 8,
};

function webMergeSourceRank(p) {
  return WEB_MERGE_SOURCE_RANK[String(p?.source ?? "")] ?? 5;
}

function dedupeWebPapersByUrl(papers) {
  const byUrl = new Map();
  for (const p of papers) {
    const u = String(p?.absUrl ?? "").trim().split("#")[0].toLowerCase();
    if (!u) continue;
    const prev = byUrl.get(u);
    if (!prev || webMergeSourceRank(p) < webMergeSourceRank(prev)) {
      byUrl.set(u, p);
    }
  }
  return Array.from(byUrl.values());
}

/** 单次 fetchMergedWebPapers 合并上限（WEB_MERGE_PER_QUERY_CAP，默认 128） */
function resolveWebMergeCaps(requestedMax) {
  const mergeCap = Math.min(
    160,
    Math.max(32, Number(process.env.WEB_MERGE_PER_QUERY_CAP) || 128),
  );
  const perSourceCap = Math.min(
    60,
    Math.max(16, Number(process.env.WEB_MERGE_PER_SOURCE_CAP) || 52),
  );
  const totalCap = Math.min(mergeCap, Math.max(20, Number(requestedMax) || 50));
  const perSource = Math.min(perSourceCap, Math.max(16, Math.ceil(totalCap * 0.88)));
  return { totalCap, perSource };
}

/**
 * 并行合并全网网页：Wikipedia / CORE / 其它显式配置源（默认不含 Bing，见 WEB_SOURCES、WEB_USE_BING）。
 * @param {string} query
 * @param {number} max 合并去重后的目标条数上限
 */
export async function fetchMergedWebPapers(query, max, opts = {}) {
  const q = String(query ?? "").trim();
  const cnQ = String(opts.chineseQuery ?? "").trim();
  const bingQ = /[\u4e00-\u9fff]/.test(cnQ) ? cnQ : q;
  const performanceTrace = opts.performanceTrace;
  const tracePrefix = String(opts.tracePrefix || "search.web.source").replace(/[^a-z0-9_.-]/gi, "_");
  const tracedSource = (source, task) => traceAsync(
    performanceTrace,
    `${tracePrefix}.${source}`,
    {},
    task,
    (value) => ({ results: Array.isArray(value?.papers) ? value.papers.length : 0, note: value?.note }),
  );
  if (!q) return { papers: [], note: "empty-query", toolName: null };

  const { totalCap, perSource } = resolveWebMergeCaps(max);
  const allow = getWebSourceAllowlist();
  const wantPreferredWeb =
    (allow.has("tavily") && Boolean(getTavilyWebSearchConfig())) ||
    (allow.has("mcp") && isMcpUsable()) ||
    allow.has("wikipedia") ||
    (allow.has("core") && Boolean(getCoreSearchConfig()));
  /** cn.bing 快路径会跳过 Dataify/Tavily/MCP；WEB_SOURCES 含它们时不走快路径 */
  const fastBing = !/^(0|false|off|no)$/i.test(String(process.env.WEB_BING_FAST_PATH ?? "1").trim());
  if (fastBing && isCnBingFallbackEnabled() && !wantPreferredWeb) {
    try {
      const bingR = await tracedSource("bing_fast", () => fetchBingWebSearch(bingQ, perSource, { cnOnly: true }));
      if (bingR.papers?.length >= 4) {
        return {
          papers: bingR.papers.slice(0, totalCap),
          note: `bing_fast:${bingR.note}(${bingR.papers.length})`,
          toolName: bingR.toolName || "bing-cn",
        };
      }
    } catch (e) {
      console.warn("[web] bing_fast failed:", e?.message);
    }
  }
  const tasks = [];

  const tavilyCap = Math.min(20, Math.ceil(perSource * 1.2));
  if (allow.has("tavily") && getTavilyWebSearchConfig()) {
    tasks.push(
      tracedSource("tavily", () => fetchTavilyWebPapers(q, tavilyCap))
        .then((r) => ({ src: "tavily", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "tavily", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("dataify") && getDataifyWebSearchConfig()) {
    tasks.push(
      tracedSource("dataify", () => fetchDataifyWebPapers(q, Math.min(64, Math.ceil(perSource * 1.35))))
        .then((r) => ({ src: "dataify", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "dataify", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("wikipedia")) {
    tasks.push(
      tracedSource("wikipedia", () => fetchWikipediaWebPapers(q, perSource))
        .then((r) => ({ src: "wikipedia", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "wikipedia", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("core") && getCoreSearchConfig()) {
    tasks.push(
      tracedSource("core", () => fetchCoreWebPapers(q, perSource))
        .then((r) => ({ src: "core", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "core", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("searx")) {
    tasks.push(
      tracedSource("searx", () => fetchSearxWebSearch(q, perSource))
        .then((r) => ({ src: "searx", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "searx", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("mcp") && isMcpUsable()) {
    tasks.push(
      tracedSource("mcp", () => fetchMcpWebPapers(q, perSource))
        .then((r) => ({ src: "mcp", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "mcp", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("bing") && isBingWebEnabled()) {
    tasks.push(
      tracedSource("bing", () => fetchBingWebSearch(q, perSource))
        .then((r) => ({ src: "bing", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "bing", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("ddg")) {
    tasks.push(
      tracedSource("ddg", () => fetchDuckDuckGoSearch(q, perSource, { skipBing: true }))
        .then((r) => ({ src: "ddg", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "ddg", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("qwant")) {
    tasks.push(
      tracedSource("qwant", () => fetchQwantWebSearch(q, perSource))
        .then((r) => ({ src: "qwant", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "qwant", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  if (allow.has("mojeek")) {
    tasks.push(
      tracedSource("mojeek", () => fetchMojeekWebSearch(q, perSource))
        .then((r) => ({ src: "mojeek", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({ src: "mojeek", papers: [], note: `err:${String(e?.message || e).slice(0, 80)}`, tool: null })),
    );
  }
  /** 与免费源并行：国内网络 DDG/SearX 常超时，cn.bing 通常可用 */
  if (isCnBingFallbackEnabled() && !allow.has("bing")) {
    tasks.push(
      tracedSource("cn_bing", () => fetchBingWebSearch(bingQ, perSource, { cnOnly: true }))
        .then((r) => ({ src: "cn_bing", papers: r.papers ?? [], note: r.note, tool: r.toolName }))
        .catch((e) => ({
          src: "cn_bing",
          papers: [],
          note: `err:${String(e?.message || e).slice(0, 80)}`,
          tool: null,
        })),
    );
  }

  if (!tasks.length) {
    return {
      papers: [],
      note: "web_no_sources:set WEB_SOURCES=wikipedia,core",
      toolName: null,
    };
  }

  const settled = await Promise.all(tasks);
  const notes = [];
  const tools = [];
  let all = [];
  for (const r of settled) {
    if (r.papers?.length) {
      all = all.concat(r.papers);
      notes.push(`${r.src}:${r.note || "ok"}(${r.papers.length})`);
      if (r.tool) tools.push(r.tool);
    } else {
      notes.push(`${r.src}:${r.note || "empty"}`);
    }
  }

  all.sort((a, b) => webMergeSourceRank(a) - webMergeSourceRank(b));
  let papers = dedupeWebPapersByUrl(all).slice(0, totalCap);
  let note = notes.join(" · ") || "web_merge_empty";
  let toolName = tools.length ? tools.join("+") : "duckduckgo-lite";

  /** 国内等环境：DDG/SearX 超时后自动用 cn.bing（不并入日常并行，避免依赖国际站） */
  if (!papers.length && isCnBingFallbackEnabled() && !allow.has("bing")) {
    try {
      const fb = await fetchBingWebSearch(q, perSource, { cnOnly: true });
      if (fb.papers?.length) {
        papers = fb.papers.slice(0, totalCap);
        note = `${note} · cn_bing_fallback:${fb.note}`;
        toolName = fb.toolName || "bing-cn";
        console.info("[web] free sources empty → cn.bing fallback ok", papers.length);
      }
    } catch (e) {
      note = `${note} · cn_bing_fallback_err:${String(e?.message || e).slice(0, 60)}`;
    }
  }

  return { papers, note, toolName };
}

/**
 * @param {string} query
 * @param {number} max
 * @param {{ forPatent?: boolean }} [opts] forPatent 为 true 时标记为 ddg_patent（专利补充检索）
 */
export async function fetchDuckDuckGoSearch(query, max, opts) {
  const forPatent = Boolean(opts && opts.forPatent);
  const skipBing = Boolean(opts && opts.skipBing);
  const sourceLabel = forPatent ? "ddg_patent" : "ddg_web";
  const toolSuffix = forPatent ? "duckduckgo-patent" : "duckduckgo-lite";
  var q = String(query || "").trim();
  if (!q) return { papers: [], note: "empty-query" };
  const tryBingFirst =
    !skipBing &&
    isBingWebEnabled() &&
    /^(1|true|on|yes)$/i.test(String(process.env.WEB_TRY_BING_FIRST ?? "").trim());
  if (tryBingFirst) {
    try {
      const bingQ = forPatent ? `${q} patent` : q;
      const bing = await fetchBingWebSearch(bingQ, max);
      if (bing.papers?.length) {
        const papers = bing.papers.map((p) => ({
          ...p,
          source: sourceLabel,
          venue: forPatent ? "Patent (Web)" : p.venue || "Web (Bing)",
        }));
        if (forPatent) {
          for (const row of papers) {
            const pn = extractPatentNumberFromPaper(row);
            if (pn) row.patentNumber = pn;
          }
        }
        return { papers, note: `bing_first:${bing.note}`, toolName: bing.toolName || "bing-cn" };
      }
    } catch (e) {
      console.warn("[ddg_web] bing_first failed:", e?.message);
    }
  }
  try {
    var html = await _ddgFetch(q);
    var items = _ddgParseResults(html, Math.min(max || 10, 20));
    if (!items.length) {
      var bingItems = await _bingFallback(q, Math.min(max || 10, 20));
      if (bingItems.length) {
        return {
          papers: _ddgToPapers(bingItems, sourceLabel, Math.min(max || 10, 28)),
          note: "bing_fallback",
          toolName: `bing-fallback${forPatent ? "-patent" : ""}`,
        };
      }
      return { papers: [], note: "no-dd-results" };
    }
    var papers = _ddgToPapers(items, sourceLabel, ddgCap);
    return { papers: papers, note: "ddg_ok", toolName: toolSuffix };
  } catch (e) {
    console.warn("[ddg_web] DuckDuckGo fetch failed:", e?.message);
    try {
      const ddgCapErr = resolveWebSourceCap(max, 16);
      var bFallback =
        isBingWebEnabled() && !skipBing
          ? await _bingFallback(q, ddgCapErr)
          : [];
      if (bFallback.length) {
        return {
          papers: _ddgToPapers(bFallback, sourceLabel, ddgCapErr),
          note: "bing_fallback_after_ddg_err",
          toolName: `bing-fallback${forPatent ? "-patent" : ""}`,
        };
      }
    } catch (e2) {
      console.warn("[ddg_web] Bing fallback also failed:", e2?.message);
    }
    return { papers: [], note: "ddg_err:" + String(e?.message || "unknown").slice(0, 100) };
  }
}

async function _bingFallback(query, max) {
  const r = await fetchBingWebSearch(query, max);
  if (!r.papers?.length) return [];
  return r.papers.map((p) => ({
    url: p.absUrl,
    title: p.title,
    description: p.summary || p.abstract || "",
  }));
}

export async function fetchPatentPapers(query, max) {
  var cfg = getMcpWebSearchConfig();
  if (cfg) {
    var braveCheck = argsLookLikeBraveSearch(cfg.args) && !braveApiKeyPresent(cfg.env);
    if (braveCheck) {
      return await fetchDuckDuckGoSearch(String(query || "").trim() + " patent", max, { forPatent: true });
    }
    const out = await fetchMcpWebPapers(String(query || "").trim() + " patent", max);
    const papers = (out.papers ?? []).map(function (p) {
      const row = {
        ...p,
        source: "ddg_patent",
        venue: "Patent (Web)",
      };
      const pn = extractPatentNumberFromPaper(row);
      if (pn) row.patentNumber = pn;
      return row;
    });
    return { papers: papers, note: out.note, toolName: out.toolName };
  }
  return await fetchDuckDuckGoSearch(String(query || "").trim() + " patent", max, { forPatent: true });
}
