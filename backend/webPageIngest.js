/**
 * 抓取网页链接正文，写入 papers 的 abstract/summary（检索结果入库前 enrich）。
 * 先普通直连；直连失败时使用 DeepSeek 官方 Fetch API（需 DEEPSEEK_API_KEY）。
 */
import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { traceAsync } from "./performanceTrace.js";
import { fetchDeepseekWebPage } from "./deepseekWebSearch.js";

const WEB_SOURCES = new Set([
  "direct_web",
  "deepseek_web",
  "doubao_web",
  "mcp_web",
  "ddg_web",
  "dataify_web",
  "baidu_web",
  "tavily_web",
  "searx_web",
  "qwant_web",
  "mojeek_web",
  "wikipedia_web",
  "core",
  "finance_web",
]);

function isWebPaper(p) {
  return WEB_SOURCES.has(String(p?.source ?? ""));
}

function isFetchableUrl(url) {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  const low = u.toLowerCase();
  if (/\.(pdf|zip|rar|7z|exe|dmg|mp4|mp3|avi)(\?|#|$)/i.test(low)) return false;
  if (low.includes("doi.org/") && !low.includes("pdf")) return true;
  return true;
}

function isWeixinArticleUrl(url) {
  try {
    const host = new URL(String(url ?? "").trim()).hostname.toLowerCase();
    return host === "mp.weixin.qq.com" || host.endsWith(".weixin.qq.com");
  } catch {
    return false;
  }
}

function decodeHtmlEntities(s) {
  return String(s ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToPlainText(html) {
  let t = String(html ?? "");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeHtmlEntities(t);
  return t.replace(/\s+/g, " ").trim();
}

function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
      "i",
    );
    const m = html.match(re);
    const v = (m && (m[1] || m[2])) || "";
    if (v.trim()) return decodeHtmlEntities(v.trim());
  }
  return "";
}

/**
 * 从正文中保留“指标 + 数值”的短证据窗口。很多行业网页把关键百分比放在
 * 表格或段落中，若只取正文开头，综合模型会看不到这些数字。
 */
function extractNumericEvidence(text) {
  const rows = String(text ?? "")
    .split(/[。；;\n]+/)
    .map((row) => row.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const metric = /产能利用率|开工率|开工负荷|负荷率|装置负荷|利用率|产量|价格|报价|均价|库存/;
  const number = /\d+(?:\.\d+)?\s*(?:%|％|万吨|万吨\/年|万?吨|元(?:\/|每)?吨|亿元|万元)/i;
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!metric.test(row) || !number.test(row)) continue;
    const value = row.slice(0, 260);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 12) break;
  }
  return out;
}

/** 识别反爬/验证页（微信公众号等），避免把「环境异常」当成正文入库 */
function detectBlockedPage(html, url) {
  const t = String(html ?? "");
  const u = String(url ?? "").toLowerCase();
  if (/mp\.weixin\.qq\.com|weixin\.qq\.com/.test(u)) {
    if (/环境异常|完成验证后即可继续访问|去验证|wappoc_appmsgcaptcha|secitptpage/i.test(t)) {
      return "weixin_captcha:微信公众号对非浏览器访问会返回验证页，无法自动抓取正文";
    }
  }
  if (/captcha|recaptcha|cf-challenge|请完成验证|访问过于频繁|robot check/i.test(t) && t.length < 8000) {
    return "captcha_page:目标站点要求人机验证，无法自动抓取";
  }
  const plain = htmlToPlainText(t);
  if (/mp\.weixin\.qq\.com/.test(u) && plain.length < 80 && /验证|小程序|轻点两下/.test(plain)) {
    return "weixin_captcha:返回内容仅为公众号验证/交互提示，非文章正文";
  }
  return null;
}

function extractFromHtml(html, fallbackTitle) {
  const title =
    metaContent(html, ["og:title", "twitter:title"]) ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const description =
    metaContent(html, ["og:description", "description", "twitter:description"]) || "";
  const body = htmlToPlainText(html);
  const text = (description && description.length >= 40 ? description : body).slice(0, 12_000);
  return {
    title: decodeHtmlEntities(title).slice(0, 500) || fallbackTitle,
    text,
    numericEvidence: extractNumericEvidence(body),
  };
}

export function parseHtmlToPageResult(html, pageUrl, finalUrl) {
  const u = String(pageUrl ?? "").trim();
  if (html.length < 80) {
    return { ok: false, error: "body_too_short", title: "", text: "" };
  }
  const blocked = detectBlockedPage(html, u);
  if (blocked) {
    return { ok: false, error: blocked, title: "", text: "" };
  }
  const parsed = extractFromHtml(html, u);
  if (parsed.text.length < 30) {
    return { ok: false, error: "no_extractable_text", title: parsed.title, text: "", numericEvidence: [] };
  }
  return {
    ok: true,
    error: null,
    title: parsed.title,
    text: parsed.text,
    numericEvidence: parsed.numericEvidence ?? [],
    finalUrl: finalUrl || u,
  };
}

async function fetchWebPageTextDirect(url, timeoutMs, signal) {
  const u = String(url ?? "").trim();
  const ua =
    String(process.env.WEB_FETCH_USER_AGENT ?? "").trim() ||
    "Mozilla/5.0 (compatible; QuantumPinnacle/1.0; +research)";

  try {
    const res = await fetchWithTimeout(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        redirect: "follow",
        signal,
      },
      timeoutMs,
    );
    const ct = String(res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}`, title: "", text: "" };
    }
    if (ct && !ct.includes("text/html") && !ct.includes("xml") && !ct.includes("json")) {
      return { ok: false, error: `content_type:${ct.slice(0, 40)}`, title: "", text: "" };
    }
    const html = await res.text();
    const parsed = parseHtmlToPageResult(html, u, res.url || u);
    if (!parsed.ok) return parsed;
    return { ...parsed, via: "direct" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120), title: "", text: "" };
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
async function fetchWebPageTextBase(url, timeoutMs = 14_000) {
  const u = String(url ?? "").trim();
  if (!isFetchableUrl(u)) return { ok: false, error: "url_not_fetchable", title: "", text: "" };

  // Direct fetch and the DeepSeek fallback share one deadline. Without this
  // budget, a slow direct request can be followed by another full provider
  // timeout and make one page hold the whole search for minutes.
  const totalTimeoutMs = Math.min(
    45_000,
    Math.max(5_000, Number(process.env.WEB_PAGE_TOTAL_TIMEOUT_MS) || 30_000),
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`web page total timeout after ${totalTimeoutMs}ms`)),
    totalTimeoutMs,
  );
  try {
    // 微信公众号页面经常对普通服务器出口返回验证页。对公开文章优先
    // 使用已配置的模型侧 Fetch 服务，成功后再回退到普通直连；这不会
    // 绕过登录权限，只是避免把本地直连的验证码页误当成文章正文。
    if (isWeixinArticleUrl(u)) {
      let official;
      try {
        official = await fetchDeepseekWebPage(u, { signal: controller.signal });
      } catch (error) {
        official = { ok: false, error: String(error?.message || error).slice(0, 120) };
      }
      if (official.ok) return official;
      const direct = await fetchWebPageTextDirect(u, timeoutMs, controller.signal);
      if (direct.ok) return direct;
      return { ...direct, error: `${direct.error}; deepseek_fetch:${official.error}` };
    }

    const direct = await fetchWebPageTextDirect(u, timeoutMs, controller.signal);
    if (direct.ok) return direct;
    let official;
    try {
      official = await fetchDeepseekWebPage(u, { signal: controller.signal });
    } catch (error) {
      official = { ok: false, error: String(error?.message || error).slice(0, 120) };
    }
    if (official.ok) return { ...official, title: official.title || direct.title || u };
    return { ...direct, error: `${direct.error}; deepseek_fetch:${official.error}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对检索结果中的网页条目抓取正文并合并进 abstract/summary。
 * @param {object[]} papers
 * @param {{ maxPages?: number; timeoutMs?: number; minExistingAbstractLen?: number; forceFetchAll?: boolean; performanceTrace?: object }} [opts]
 */
export async function enrichPapersWithWebPageContent(papers, opts = {}) {
  const enabled = String(process.env.WEB_FETCH_ENABLED ?? "1").trim() !== "0";
  if (!enabled) return { papers, fetched: 0, skipped: 0, errors: 0 };

  const forceFetchAll = Boolean(opts.forceFetchAll);
  const maxPages = Math.min(40, Math.max(1, Number(opts.maxPages ?? process.env.WEB_FETCH_MAX_PAGES ?? 10)));
  const timeoutMs = Math.min(25_000, Math.max(5000, Number(opts.timeoutMs ?? process.env.WEB_FETCH_TIMEOUT_MS ?? 14_000)));
  const minSnippet = Number(opts.minExistingAbstractLen ?? 120);
  const maxChars = Math.min(12_000, Math.max(500, Number(process.env.WEB_FETCH_MAX_CHARS ?? 6000)));

  const list = Array.isArray(papers) ? [...papers] : [];
  const webCandidates = list.filter((p) => isWebPaper(p) && isFetchableUrl(p.absUrl));
  const shortSnippet = webCandidates.filter(
    (p) => String(p.summary ?? p.abstract ?? "").trim().length < minSnippet,
  );
  const targets = opts.skipCompleteSnippets ? shortSnippet.slice(0, maxPages) : (forceFetchAll
    ? webCandidates.slice(0, maxPages)
    : (shortSnippet.length ? shortSnippet : webCandidates).slice(0, maxPages));

  let fetched = 0;
  let skipped = list.filter((p) => isWebPaper(p)).length - targets.length;
  let errors = 0;

  const byId = new Map(list.map((p) => [String(p.paper_id ?? p.id ?? ""), { ...p }]));

  /**
   * 网页正文抓取使用小型 worker pool：保留结果顺序，但允许多个站点同时请求，
   * 避免单个慢站点把后续所有页面串行阻塞。默认 4 路，最多 6 路。
   */
  const concurrency = Math.min(
    6,
    Math.max(1, Number(opts.concurrency ?? process.env.WEB_FETCH_CONCURRENCY) || 4),
  );
  let nextIndex = 0;
  const fetchOne = async (t) => {
    const key = String(t.paper_id ?? t.id ?? "");
    const url = String(t.absUrl ?? "").trim();
    const row = byId.get(key) || { ...t };
    const got = await traceAsync(
      opts.performanceTrace,
      "search.web_page_fetch.item",
      { source: String(t.source ?? ""), urlHost: (() => { try { return new URL(url).hostname; } catch { return ""; } })() },
      () => fetchWebPageText(url, timeoutMs, { signal: opts.signal, totalTimeoutMs: opts.totalTimeoutMs }),
      (value) => ({ ok: Boolean(value?.ok), via: value?.via, error: value?.error }),
    );
    return { key, row, got };
  };
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= targets.length) return;
      results[index] = await fetchOne(targets[index]);
    }
  };
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()),
  );

  for (const result of results) {
    const { key, row, got } = result;
    if (!got.ok) {
      errors++;
      row.webFetchNote = got.error;
      byId.set(key, row);
      continue;
    }
    fetched++;
    const mergedText = got.text.slice(0, maxChars);
    const prev = String(row.summary ?? row.abstract ?? "").trim();
    const evidence = Array.isArray(got.numericEvidence) ? got.numericEvidence : [];
    const evidenceText = evidence.length ? `\n\n【数值证据】${evidence.join("；")}` : "";
    const candidateText = `${mergedText}${evidenceText}`.slice(0, maxChars + 2600);
    row.summary = prev.length > candidateText.length ? prev : candidateText;
    row.abstract = row.summary;
    if (evidence.length) row.webEvidence = evidence;
    // `url` belongs to the worker-local fetch scope. Use the row's URL here
    // instead of referencing that out-of-scope variable (which previously
    // caused `url is not defined` after a successful page fetch).
    const rowUrl = String(row.absUrl ?? row.url ?? "").trim();
    if (got.title && (!row.title || row.title === rowUrl || row.title.length < 12)) {
      row.title = got.title.slice(0, 400);
    }
    row.webFetchNote = got.via === "deepseek_fetch" ? "fetched:deepseek" : "fetched";
    row.webFetchedAt = Date.now();
    byId.set(key, row);
  }

  return {
    papers: [...byId.values()],
    fetched,
    skipped,
    errors,
    attempted: targets.length,
  };
}

export async function fetchWebPageText(url, timeoutMs = 14000, opts = {}) {
  if (!opts.signal && !opts.totalTimeoutMs) return fetchWebPageTextBase(url, timeoutMs);
  const u = String(url ?? "").trim();
  if (!isFetchableUrl(u)) return { ok: false, error: "url_not_fetchable", title: "", text: "" };
  const budget = Math.min(45000, Math.max(1000, Number(opts.totalTimeoutMs) || 8000));
  const controller = new AbortController();
  let timer, abortHandler;
  const fallback = { ok: false, error: "page_deadline", title: "", text: "" };
  const deadline = new Promise(resolve => {
    abortHandler = () => { controller.abort(opts.signal.reason); resolve(fallback); };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });
    timer = setTimeout(() => { controller.abort(new Error("page deadline")); resolve(fallback); }, budget);
  });
  if (opts.signal?.aborted) abortHandler();
  const work = async () => {
    if (controller.signal.aborted) return fallback;
    const direct = await fetchWebPageTextDirect(u, Math.min(timeoutMs, budget), controller.signal);
    if (direct.ok || controller.signal.aborted) return direct.ok ? direct : fallback;
    try {
      const official = await fetchDeepseekWebPage(u, { signal: controller.signal });
      return official.ok ? { ...official, title: official.title || direct.title || u } : direct;
    } catch { return direct; }
  };
  try { return await Promise.race([work(), deadline]); }
  finally { clearTimeout(timer); opts.signal?.removeEventListener("abort", abortHandler); }
}
