import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 4;
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function isProxyFakeIpv4(address) {
  const parts = String(address ?? "").split(".").map(Number);
  return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

function resolveIpv4WithGoogleDoh(hostname) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = https.get({
      hostname: "dns.google",
      servername: "dns.google",
      path: `/resolve?name=${encodeURIComponent(hostname)}&type=A`,
      headers: { Accept: "application/dns-json" },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) return callback(null, [{ address: "8.8.8.8", family: 4 }]);
        return callback(null, "8.8.8.8", 4);
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish([]);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          request.destroy();
          finish([]);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          finish((data?.Answer ?? [])
            .filter((answer) => Number(answer?.type) === 1 && net.isIP(String(answer?.data ?? "")) === 4)
            .map((answer) => ({ address: String(answer.data), family: 4 }))
            .filter(({ address }) => !isBlockedIp(address)));
        } catch {
          finish([]);
        }
      });
      response.on("error", () => finish([]));
    });
    request.setTimeout(5000, () => request.destroy());
    request.on("error", () => finish([]));
  });
}

export class PdfFulfillmentError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "PdfFulfillmentError";
    this.code = code;
    this.status = status;
  }
}

function isBlockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIp(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (/^fe[89ab]/.test(normalized)) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // unique-local
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // Documentation, multicast, and other non-global ranges.
  return normalized.startsWith("2001:db8:") || normalized.startsWith("ff");
}

async function validateAndResolve(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PdfFulfillmentError("invalid-pdf-source", "Stored PDF source URL is invalid", 422);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PdfFulfillmentError("invalid-pdf-source", "Stored PDF source must use HTTP or HTTPS", 422);
  }
  if (url.username || url.password) {
    throw new PdfFulfillmentError("invalid-pdf-source", "Stored PDF source must not contain credentials", 422);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new PdfFulfillmentError("blocked-pdf-source", "Stored PDF source host is not allowed", 422);
  }

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new PdfFulfillmentError("pdf-source-unreachable", "PDF source host could not be resolved");
    }
  }
  // Clash 等代理的 fake-IP 模式会把公开域名解析到 198.18/15。仅对域名
  // 使用固定公共 DNS 复核；URL 中直接写入该保留地址仍然会被拒绝。
  if (!net.isIP(hostname) && addresses.some(({ address }) => isProxyFakeIpv4(address))) {
    const publicAddresses = await resolveIpv4WithGoogleDoh(hostname);
    if (publicAddresses.length) addresses = publicAddresses;
  }
  // When public DoH is unavailable, Clash fake-IP is still safe to use for a
  // syntactically public hostname: the reserved address is pinned and routed by
  // the local proxy. Literal 198.18/15 URLs remain blocked above/below.
  const proxyFakeHostname = !net.isIP(hostname) && addresses.length > 0
    && addresses.every(({ address }) => isProxyFakeIpv4(address));
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address) && !proxyFakeHostname)) {
    throw new PdfFulfillmentError("blocked-pdf-source", "PDF source resolved to a non-public address", 422);
  }
  return { url, address: addresses[0] };
}

function requestOnce(url, pinnedAddress, { maxBytes, maxHtmlBytes, timeoutMs, referer }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const headers = {
      Accept: "application/pdf,text/html,application/xhtml+xml;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; QuantumPinnacle-PdfCrawler/1.0; +research)",
    };
    if (/^https?:\/\//i.test(String(referer ?? ""))) headers.Referer = String(referer);
    const request = transport.get(url, {
      headers,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) return callback(null, [pinnedAddress]);
        return callback(null, pinnedAddress.address, pinnedAddress.family);
      },
    });
    let timer = null;
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        request.destroy(new PdfFulfillmentError("pdf-fetch-timeout", "PDF source stopped sending data", 504));
      }, timeoutMs);
    };
    armTimer();

    request.on("response", (response) => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        clearTimeout(timer);
        return resolve({ redirect: new URL(location, url).toString() });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        clearTimeout(timer);
        return reject(new PdfFulfillmentError("pdf-source-error", `PDF source returned HTTP ${status}`, 502));
      }

      const contentType = String(response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      const htmlResponse = contentType.includes("html") || contentType.includes("xhtml") || contentType.includes("xml");
      const responseLimit = htmlResponse ? Math.min(maxBytes, maxHtmlBytes) : maxBytes;
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > responseLimit) {
        response.destroy();
        clearTimeout(timer);
        return reject(new PdfFulfillmentError(
          htmlResponse ? "pdf-source-page-too-large" : "pdf-too-large",
          htmlResponse ? "PDF source page exceeds the server size limit" : "PDF exceeds the server size limit",
          413,
        ));
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        armTimer();
        total += chunk.length;
        if (total > responseLimit) {
          response.destroy(new PdfFulfillmentError(
            htmlResponse ? "pdf-source-page-too-large" : "pdf-too-large",
            htmlResponse ? "PDF source page exceeds the server size limit" : "PDF exceeds the server size limit",
            413,
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        resolve({
          buffer: Buffer.concat(chunks, total),
          contentType,
          finalUrl: url.toString(),
        });
      });
      response.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof PdfFulfillmentError
        ? error
        : new PdfFulfillmentError("pdf-source-unreachable", "PDF source could not be fetched"));
    });
  });
}

async function fetchResourceSecurely(rawUrl, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const maxHtmlBytes = Number.isSafeInteger(options.maxHtmlBytes) && options.maxHtmlBytes > 0
    ? options.maxHtmlBytes
    : DEFAULT_MAX_HTML_BYTES;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxRedirects = Number.isSafeInteger(options.maxRedirects) && options.maxRedirects >= 0
    ? options.maxRedirects
    : DEFAULT_MAX_REDIRECTS;

  let nextUrl = String(rawUrl || "").trim();
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const { url, address } = await validateAndResolve(nextUrl);
    const result = await requestOnce(url, address, { maxBytes, maxHtmlBytes, timeoutMs, referer: options.referer });
    if (result.redirect) {
      if (redirectCount === maxRedirects) {
        throw new PdfFulfillmentError("too-many-redirects", "PDF source redirected too many times", 502);
      }
      nextUrl = result.redirect;
      continue;
    }
    return result;
  }
  throw new PdfFulfillmentError("too-many-redirects", "PDF source redirected too many times", 502);
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function decodeHtmlEntities(value) {
  const codePoint = (raw, radix) => {
    const number = Number.parseInt(raw, radix);
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
  };
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, number) => codePoint(number, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => codePoint(hex, 16));
}

function absoluteHttpUrl(value, baseUrl) {
  const decoded = decodeHtmlEntities(value).replace(/\\\//g, "/").trim();
  if (!decoded || /^(?:javascript|data|blob|mailto):/i.test(decoded)) return null;
  try {
    const url = new URL(decoded, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Extract public PDF hints from an article/repository landing page. */
export function extractPublicPdfLinks(page, baseUrl) {
  const html = Buffer.isBuffer(page) ? page.toString("utf8") : String(page ?? "");
  const raw = [];
  const addMatches = (regexp, trustedPdfHint = false) => {
    for (const match of html.matchAll(regexp)) raw.push({ value: match[1] || match[2] || "", trustedPdfHint });
  };
  addMatches(/<meta[^>]+(?:name|property)=["'](?:citation_pdf_url|og:pdf)["'][^>]+content=["']([^"']+)["']/gi, true);
  addMatches(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:citation_pdf_url|og:pdf)["']/gi, true);
  addMatches(/<(?:a|link)\b(?=[^>]*\btype=["']application\/pdf["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi, true);
  addMatches(/<a\b[^>]+href=["']([^"']+)["'][^>]*>[\s\S]{0,120}?(?:pdf|download|full\s*text)[\s\S]{0,120}?<\/a>/gi, true);
  addMatches(/<(?:a|link|iframe|embed|source)\b[^>]+(?:href|src)=["']([^"']+)["'][^>]*>/gi);
  addMatches(/<object\b[^>]+data=["']([^"']+)["'][^>]*>/gi);

  const output = [];
  const seen = new Set();
  for (const { value, trustedPdfHint } of raw) {
    const absolute = absoluteHttpUrl(value, baseUrl);
    if (!absolute) continue;
    if (!trustedPdfHint && !/(?:\.pdf(?:$|[?#])|\/pdf(?:$|[/?#])|[?&](?:pdf|download)=|\/download(?:$|[/?#])|bitstream|viewcontent)/i.test(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    output.push(absolute);
    if (output.length >= 10) break;
  }
  return output;
}

export function extractPageDoi(page) {
  const html = Buffer.isBuffer(page) ? page.toString("utf8") : String(page ?? "");
  const meta = html.match(/<meta[^>]+(?:name|property)=["'](?:citation_doi|dc\.identifier|dc\.identifier\.doi)["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:citation_doi|dc\.identifier|dc\.identifier\.doi)["']/i);
  const text = decodeHtmlEntities(meta?.[1] || meta?.[2] || "");
  const match = text.match(/\b10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/i);
  return match ? match[0].replace(/[.,;:)'"\]}]+$/, "").toLowerCase() : null;
}

function looksLikeHtml(result) {
  const type = String(result?.contentType ?? "").toLowerCase();
  if (type.includes("html") || type.includes("xhtml") || type.includes("xml")) return true;
  const prefix = result?.buffer?.subarray(0, 512).toString("utf8").trimStart().toLowerCase() ?? "";
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<?xml");
}

export async function fetchPdfSecurely(rawUrl, options = {}) {
  const result = await fetchResourceSecurely(rawUrl, options);
  if (!isPdfBuffer(result.buffer)) {
    throw new PdfFulfillmentError("invalid-pdf-content", "Fetched content is not a PDF", 422);
  }
  if (result.contentType && !["application/pdf", "application/octet-stream", "binary/octet-stream"].includes(result.contentType)) {
    throw new PdfFulfillmentError("invalid-pdf-content-type", "PDF source returned an unexpected content type", 422);
  }
  return result;
}

/**
 * Resolve only public/direct PDF links from the stored citation, its landing
 * page, and lawful OA APIs. Login/paywall/captcha bypass is intentionally absent.
 */
export async function fetchPdfFromSourcesSecurely(source, options = {}) {
  const fetchResource = options.fetchResource ?? fetchResourceSecurely;
  const resolveOpenAccess = options.resolveOpenAccess;
  const maxCandidates = Math.min(24, Math.max(1, Number(options.maxCandidates) || 16));
  const totalTimeoutMs = Math.min(180_000, Math.max(5_000, Number(options.totalTimeoutMs) || 35_000));
  const deadline = Date.now() + totalTimeoutMs;
  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const doiQueue = [];
  const resolvedDois = new Set();
  let landingPages = 0;
  let lastError = null;

  const enqueue = (url, referer = "") => {
    const value = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(value) || queued.has(value) || visited.has(value)) return;
    queued.add(value);
    queue.push({ url: value, referer: String(referer ?? "") });
  };
  const enqueueDoi = (doi) => {
    const value = String(doi ?? "").trim().toLowerCase();
    if (!/^10\.\d{4,9}\//i.test(value) || resolvedDois.has(value) || doiQueue.includes(value)) return;
    doiQueue.push(value);
  };
  enqueue(source?.pdfUrl ?? source?.pdf_url);
  enqueue(source?.absUrl ?? source?.abs_url);
  enqueueDoi(source?.doi);

  while ((queue.length || doiQueue.length) && visited.size < maxCandidates && Date.now() < deadline) {
    if (!queue.length) {
      const doi = doiQueue.shift();
      resolvedDois.add(doi);
      if (typeof resolveOpenAccess === "function") {
        try {
          const candidates = await resolveOpenAccess(doi);
          for (const candidate of Array.isArray(candidates) ? candidates : []) enqueue(typeof candidate === "string" ? candidate : candidate?.url);
        } catch (error) { lastError = error; }
      }
      continue;
    }
    const candidate = queue.shift();
    queued.delete(candidate.url);
    if (visited.has(candidate.url)) continue;
    visited.add(candidate.url);
    try {
      const result = await fetchResource(candidate.url, {
        ...options,
        timeoutMs: Math.max(500, Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, deadline - Date.now())),
        referer: candidate.referer,
      });
      if (isPdfBuffer(result.buffer)) return result;
      if (!looksLikeHtml(result) || landingPages >= 4) continue;
      landingPages += 1;
      const finalUrl = result.finalUrl || candidate.url;
      for (const pdfUrl of extractPublicPdfLinks(result.buffer, finalUrl)) enqueue(pdfUrl, finalUrl);
      enqueueDoi(extractPageDoi(result.buffer));
    } catch (error) { lastError = error; }
  }
  const cause = lastError?.message ? ` (${String(lastError.message).slice(0, 180)})` : "";
  throw new PdfFulfillmentError(
    "public-pdf-not-found",
    `该来源未找到可公开下载的 PDF；页面可能只有摘要、需要登录，或站点阻止了自动下载${cause}`,
    422,
  );
}
