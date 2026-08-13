/**
 * 抓取网页链接正文，写入 papers 的 abstract/summary（检索结果入库前 enrich）。
 * 可选 Dataify 通用采集（webunlocker）：直连失败或反爬时回退，见 DATAIFY_WEBUNLOCKER_*。
 */
import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { traceAsync } from "./performanceTrace.js";
import { fetchDataifyWebUnlockerHtml, getDataifyWebUnlockerConfig } from "./dataifyWebUnlocker.js";

const WEB_SOURCES = new Set([
  "mcp_web",
  "ddg_web",
  "dataify_web",
  "tavily_web",
  "searx_web",
  "qwant_web",
  "mojeek_web",
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
  };
}

function parseHtmlToPageResult(html, pageUrl, finalUrl) {
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
    return { ok: false, error: "no_extractable_text", title: parsed.title, text: "" };
  }
  return {
    ok: true,
    error: null,
    title: parsed.title,
    text: parsed.text,
    finalUrl: finalUrl || u,
  };
}

async function fetchWebPageTextDirect(url, timeoutMs) {
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

async function fetchWebPageTextDataify(url, unlockerCfg) {
  const u = String(url ?? "").trim();
  const got = await fetchDataifyWebUnlockerHtml(u, unlockerCfg);
  if (!got.ok) {
    return { ok: false, error: got.error, title: "", text: "" };
  }
  const parsed = parseHtmlToPageResult(got.html, u, got.finalUrl || u);
  if (!parsed.ok) return parsed;
  return { ...parsed, via: "dataify_unlocker" };
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function fetchWebPageText(url, timeoutMs = 14_000) {
  const u = String(url ?? "").trim();
  if (!isFetchableUrl(u)) return { ok: false, error: "url_not_fetchable", title: "", text: "" };

  const unlockerCfg = getDataifyWebUnlockerConfig();
  const unlockerTimeout = unlockerCfg?.timeoutMs ?? timeoutMs;

  if (unlockerCfg?.mode === "always") {
    const dataify = await fetchWebPageTextDataify(u, unlockerCfg);
    if (dataify.ok) return dataify;
    const direct = await fetchWebPageTextDirect(u, timeoutMs);
    return direct.ok ? direct : dataify;
  }

  const direct = await fetchWebPageTextDirect(u, timeoutMs);
  if (direct.ok) return direct;

  if (unlockerCfg) {
    const dataify = await fetchWebPageTextDataify(u, { ...unlockerCfg, timeoutMs: unlockerTimeout });
    if (dataify.ok) return dataify;
    return {
      ok: false,
      error: `${direct.error}; ${dataify.error}`,
      title: dataify.title || direct.title || "",
      text: "",
    };
  }

  return direct;
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
  const maxPages = Math.min(20, Math.max(1, Number(opts.maxPages ?? process.env.WEB_FETCH_MAX_PAGES ?? 10)));
  const timeoutMs = Math.min(25_000, Math.max(5000, Number(opts.timeoutMs ?? process.env.WEB_FETCH_TIMEOUT_MS ?? 14_000)));
  const minSnippet = Number(opts.minExistingAbstractLen ?? 120);
  const maxChars = Math.min(12_000, Math.max(500, Number(process.env.WEB_FETCH_MAX_CHARS ?? 6000)));

  const list = Array.isArray(papers) ? [...papers] : [];
  const webCandidates = list.filter((p) => isWebPaper(p) && isFetchableUrl(p.absUrl));
  const shortSnippet = webCandidates.filter(
    (p) => String(p.summary ?? p.abstract ?? "").trim().length < minSnippet,
  );
  const targets = forceFetchAll
    ? webCandidates.slice(0, maxPages)
    : (shortSnippet.length ? shortSnippet : webCandidates).slice(0, maxPages);

  let fetched = 0;
  let skipped = list.filter((p) => isWebPaper(p)).length - targets.length;
  let errors = 0;

  const byId = new Map(list.map((p) => [String(p.paper_id ?? p.id ?? ""), { ...p }]));

  for (const t of targets) {
    const key = String(t.paper_id ?? t.id ?? "");
    const url = String(t.absUrl ?? "").trim();
    const row = byId.get(key) || { ...t };
    const got = await traceAsync(
      opts.performanceTrace,
      "search.web_page_fetch.item",
      { source: String(t.source ?? ""), urlHost: (() => { try { return new URL(url).hostname; } catch { return ""; } })() },
      () => fetchWebPageText(url, timeoutMs),
      (value) => ({ ok: Boolean(value?.ok), via: value?.via, error: value?.error }),
    );
    if (!got.ok) {
      errors++;
      row.webFetchNote = got.error;
      byId.set(key, row);
      continue;
    }
    fetched++;
    const mergedText = got.text.slice(0, maxChars);
    const prev = String(row.summary ?? row.abstract ?? "").trim();
    row.summary = prev.length > mergedText.length ? prev : mergedText;
    row.abstract = row.summary;
    if (got.title && (!row.title || row.title === url || row.title.length < 12)) {
      row.title = got.title.slice(0, 400);
    }
    row.webFetchNote = got.via === "dataify_unlocker" ? "fetched:dataify" : "fetched";
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
