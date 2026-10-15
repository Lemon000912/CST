import crypto from "node:crypto";
import { fetchPublicResourceSecurely } from "./pdfFulfillment.js";
import { fetchWebPageText, parseHtmlToPageResult } from "./webPageIngest.js";
import { extractDoiCandidate } from "./doi.js";

const MAX_URLS = 32;

export function extractHttpUrls(text, max = MAX_URLS) {
  const raw = String(text ?? "");
  const found = raw.match(/https?:\/\/[^\s<>\]})"'，。、；！？]+/gi) || [];
  const out = [];
  const seen = new Set();
  for (const value of found) {
    const candidate = String(value).replace(/[\u0000-\u001f]/g, "").replace(/[.,;!?，。、；！？]+$/g, "");
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const normalized = url.toString();
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.min(MAX_URLS, Math.max(1, Number(max) || MAX_URLS))) break;
  }
  return out;
}

function stableId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 22);
}

function isPdfUrl(url, contentType = "") {
  return /\.pdf(?:$|[?#])/i.test(url) || /application\/pdf/i.test(contentType);
}

export function decodeHtmlBuffer(buffer, contentType = "") {
  const prefix = buffer.subarray(0, 8192).toString("latin1");
  const charset = String(contentType).match(/charset\s*=\s*["']?([a-z0-9._-]+)/i)?.[1]
    || prefix.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i)?.[1]
    || "utf-8";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function evidenceFromText(text) {
  const rows = String(text ?? "").split(/[。；;\n]+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  const metric = /产能利用率|开工率|开工负荷|负荷率|装置负荷|利用率|产量|价格|报价|库存/;
  const number = /\d+(?:\.\d+)?\s*(?:%|％|万吨|万吨\/年|万?吨|元(?:\/|每)?吨|亿元|万元)/i;
  return [...new Set(rows.filter((row) => metric.test(row) && number.test(row)).map((row) => row.slice(0, 360)))].slice(0, 16);
}

async function fetchDirectPdf(url, timeoutMs, maxBytes = 20 * 1024 * 1024) {
  const response = await fetchPublicResourceSecurely(url, { timeoutMs, maxBytes, maxHtmlBytes: 2 * 1024 * 1024 });
  const contentType = String(response.contentType || "");
  if (!isPdfUrl(response.finalUrl || url, contentType)) return { ok: false, error: `content_type:${contentType.slice(0, 60)}` };
  const buffer = response.buffer;
  return parseDirectPdfBuffer(buffer, response.finalUrl || url, maxBytes);
}

async function parseDirectPdfBuffer(buffer, url, maxBytes) {
  if (buffer.length > maxBytes || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") return { ok: false, error: "invalid_pdf" };
  try {
    const mod = await import("pdf-parse");
    const pdfParse = mod.default ?? mod;
    const parsed = await pdfParse(buffer);
    const text = String(parsed?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 16_000);
    return { ok: Boolean(text), text, title: url.split("/").pop() || url, numericEvidence: evidenceFromText(text), finalUrl: url };
  } catch (error) {
    return { ok: false, error: `pdf_parse:${String(error?.message || error).slice(0, 100)}` };
  }
}

async function fetchDirectUrl(url, timeoutMs) {
  if (isPdfUrl(url)) return fetchDirectPdf(url, timeoutMs);
  try {
    const response = await fetchPublicResourceSecurely(url, {
      timeoutMs,
      maxBytes: 20 * 1024 * 1024,
      maxHtmlBytes: 2 * 1024 * 1024,
    });
    const contentType = String(response.contentType || "");
    if (isPdfUrl(response.finalUrl || url, contentType)) {
      return parseDirectPdfBuffer(response.buffer, response.finalUrl || url, 20 * 1024 * 1024);
    }
    if (contentType && !/text\/html|xhtml|xml/i.test(contentType)) {
      return { ok: false, error: `content_type:${contentType.slice(0, 60)}` };
    }
    const parsed = parseHtmlToPageResult(decodeHtmlBuffer(response.buffer, contentType), url, response.finalUrl || url);
    return parsed.ok ? { ...parsed, via: "direct" } : parsed;
  } catch (error) {
    if (/blocked|private|not allowed|non-public|credentials/i.test(String(error?.code || ""))
      || /blocked|private|not allowed|non-public/i.test(String(error?.message || error))) {
      return { ok: false, error: String(error?.message || error).slice(0, 160) };
    }
    // Some CDN/WAFs reject the pinned-address HTTP client used for SSRF-safe
    // PDF retrieval while accepting ordinary HTTPS fetches. Keep the secure
    // path first, then use the normal page fetcher as a bounded HTML fallback.
    const fallback = await fetchWebPageText(url, timeoutMs).catch(() => null);
    if (fallback?.ok) return { ...fallback, via: fallback.via || "direct_fallback" };
    return { ok: false, error: String(error?.message || error).slice(0, 160) };
  }
}

export async function fetchDirectWebPapers(input, opts = {}) {
  const urls = Array.isArray(input) ? input : extractHttpUrls(input, opts.maxUrls);
  const timeoutMs = Math.min(30_000, Math.max(5_000, Number(opts.timeoutMs) || 18_000));
  const concurrency = Math.min(6, Math.max(1, Number(opts.concurrency) || 3));
  const results = new Array(urls.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= urls.length) return;
      const url = urls[index];
      try {
        const page = await fetchDirectUrl(url, timeoutMs);
        if (!page?.ok) {
          results[index] = { url, ok: false, error: page?.error || "fetch_failed" };
          continue;
        }
        const finalUrl = String(page.finalUrl || url).trim();
        const text = String(page.text || "").trim();
        const title = String(page.title || finalUrl).slice(0, 500);
        const summary = `${text}${page.numericEvidence?.length ? `\n\n【数值证据】${page.numericEvidence.join("；")}` : ""}`.slice(0, 18_000);
        results[index] = {
          ok: true,
          paper: {
            paper_id: `direct_web:${stableId(finalUrl)}`,
            id: stableId(finalUrl),
            title,
            abstract: summary,
            summary,
            authors: [],
            authors_json: JSON.stringify([]),
            year: null,
            venue: "用户指定网页",
            absUrl: finalUrl,
            pdfUrl: finalUrl,
            doi: extractDoiCandidate(`${finalUrl} ${summary}`),
            source: "direct_web",
            webEvidence: page.numericEvidence || [],
            webFetchNote: "fetched:direct",
          },
        };
      } catch (error) {
        results[index] = { url, ok: false, error: String(error?.message || error).slice(0, 160) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return {
    urls,
    papers: results.filter((x) => x?.ok && x.paper).map((x) => x.paper),
    failures: results.filter((x) => x && !x.ok).map((x) => ({ url: x.url, error: x.error })),
  };
}
