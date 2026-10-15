/**
 * 百度网页搜索 - 通过 HTML 爬取（免费方案）
 *
 * 环境变量：
 * - BAIDU_WEB_ENABLED=1  启用百度搜索
 * - BAIDU_WEB_TIMEOUT_MS=8000  超时时间（默认8秒）
 * - BAIDU_WEB_MAX_RESULTS=15  每次查询最多返回结果数
 */

import crypto from "node:crypto";

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_MAX = 15;

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 是否启用百度搜索 */
export function isBaiduWebEnabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.BAIDU_WEB_ENABLED ?? "1").trim());
}

/** 百度搜索超时时间 */
function baiduTimeoutMs() {
  const n = Number(process.env.BAIDU_WEB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(30_000, n) : DEFAULT_TIMEOUT;
}

/** 百度搜索最大结果数 */
function baiduMaxResults() {
  const n = Number(process.env.BAIDU_WEB_MAX_RESULTS);
  return Number.isFinite(n) && n > 0 ? Math.min(50, n) : DEFAULT_MAX;
}

/**
 * 解析百度搜索结果 HTML
 * @param {string} html
 * @param {number} max
 * @returns {Array<{url: string, title: string, description: string}>}
 */
function parseBaiduResults(html, max) {
  const results = [];

  // 百度结果通常在 class="result" 或 class="c-container" 的 div 中
  // 匹配模式：<div ... class="result ..." ... data-mu="..." ...>
  const resultBlockRe = /<div[^>]*class="(?:result|c-container)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let blockMatch;

  while ((blockMatch = resultBlockRe.exec(html)) !== null && results.length < max) {
    const block = blockMatch[1];

    // 提取链接
    const linkMatch = /<a[^>]*href="([^"]+)"[^>]*class="(?:c-showurl|t)"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
                     /<a[^>]*class="(?:c-showurl|t)"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

    if (!linkMatch) continue;

    let url = linkMatch[1];

    // 百度会包装链接，需要提取真实URL
    if (url.includes("baidu.com/link")) {
      // 尝试从 data-mu 属性提取
      const muMatch = /data-mu="([^"]+)"/i.exec(block);
      if (muMatch) {
        try {
          url = decodeURIComponent(muMatch[1]);
        } catch (e) {
          url = muMatch[1];
        }
      }
    }

    // 过滤百度自己的链接
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (url.includes("baidu.com") && !url.includes("baijiahao.baidu.com")) continue;

    // 提取标题
    const titleMatch = /<(?:h3|a)[^>]*class="(?:t|c-title)"[^>]*>([\s\S]*?)<\/(?:h3|a)>/i.exec(block);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";

    // 提取描述
    const descMatch = /<div[^>]*class="(?:c-abstract|c-span9)"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

    // 去重
    const isDuplicate = results.some(r => r.url === url);
    if (!isDuplicate && url && title) {
      results.push({
        url: url.split("#")[0],
        title: title.slice(0, 400),
        description: description.slice(0, 1200),
      });
    }
  }

  return results.slice(0, max);
}

/**
 * 转换为标准 paper 格式
 * @param {Array<{url: string, title: string, description: string}>} items
 * @param {number} max
 */
function baiduToPapers(items, max) {
  const seen = new Set();
  const papers = [];
  const cap = Math.min(50, Math.max(1, max || 15));

  for (const item of items) {
    if (papers.length >= cap) break;
    const url = String(item.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const id = crypto.createHash("sha256").update(url).digest("hex").slice(0, 22);
    papers.push({
      id: `baidu_${id}`,
      title: String(item.title || "Web").slice(0, 500),
      abstract: String(item.description || "").slice(0, 2000),
      absUrl: url,
      source: "baidu_web",
      year: null,
      citationCount: null,
      publicationDate: null,
    });
  }

  return papers;
}

/**
 * 百度网页搜索
 * @param {string} query
 * @param {number} max
 * @param {object} opts
 * @returns {Promise<{papers: any[], note: string, toolName: string}>}
 */
export async function fetchBaiduWebSearch(query, max, opts = {}) {
  if (!isBaiduWebEnabled()) {
    return { papers: [], note: "baidu_disabled", toolName: "baidu" };
  }

  const q = String(query ?? "").trim();
  if (!q) {
    return { papers: [], note: "empty-query", toolName: "baidu" };
  }

  const cap = Math.min(50, Math.max(1, max || baiduMaxResults()));
  const timeout = baiduTimeoutMs();

  // 百度搜索URL - 使用 rn 参数控制结果数
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${Math.min(50, cap * 2)}`;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const onAbort = () => controller?.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Referer": "https://www.baidu.com/",
      },
      signal: controller?.signal,
    });

    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);

    if (!res.ok) {
      console.warn("[baidu_web] HTTP", res.status);
      return { papers: [], note: `baidu_http_${res.status}`, toolName: "baidu" };
    }

    const html = await res.text();
    if (html.length < 500) {
      return { papers: [], note: "baidu_no_results", toolName: "baidu" };
    }

    const items = parseBaiduResults(html, cap);
    const papers = baiduToPapers(items, cap);

    return {
      papers,
      note: papers.length > 0 ? "baidu_ok" : "baidu_no_results",
      toolName: "baidu",
    };

  } catch (e) {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);

    if (opts.signal?.aborted) {
      throw e;
    }

    console.warn("[baidu_web]", e?.message || String(e));
    return { papers: [], note: "baidu_err:" + (e?.message || "fetch failed"), toolName: "baidu" };
  }
}

/**
 * 获取百度搜索配置（用于状态检查）
 */
export function getBaiduWebSearchConfig() {
  if (!isBaiduWebEnabled()) return null;
  return {
    enabled: true,
    timeout: baiduTimeoutMs(),
    maxResults: baiduMaxResults(),
  };
}
