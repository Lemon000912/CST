/** Wikipedia MediaWiki API 搜索适配器（网页渠道）。 */
import crypto from "node:crypto";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const DEFAULT_LANG = "zh";
const DEFAULT_TIMEOUT_MS = 10_000;

function stableId(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 22);
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function getWikipediaSearchConfig() {
  const lang = String(process.env.WIKIPEDIA_LANG ?? DEFAULT_LANG)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "") || DEFAULT_LANG;
  const timeoutMs = Math.min(
    30_000,
    Math.max(3000, Number(process.env.WIKIPEDIA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  );
  const maxResults = Math.min(50, Math.max(1, Number(process.env.WIKIPEDIA_MAX_RESULTS) || 20));
  return { lang, timeoutMs, maxResults };
}

/** @returns {Promise<{papers: object[]; note: string; toolName: string}>} */
export async function fetchWikipediaWebPapers(query, max) {
  const q = String(query ?? "").trim();
  const cfg = getWikipediaSearchConfig();
  if (!q) return { papers: [], note: "empty-query", toolName: "wikipedia" };
  const cap = Math.min(cfg.maxResults, Math.max(1, Number(max) || cfg.maxResults));
  const endpoint = `https://${cfg.lang}.wikipedia.org/w/api.php`;
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: q.slice(0, 300),
    srlimit: String(cap),
    srprop: "snippet|timestamp",
    format: "json",
    utf8: "1",
    origin: "*",
  });
  try {
    const r = await fetchWithTimeout(
      `${endpoint}?${params.toString()}`,
      { headers: { Accept: "application/json", "User-Agent": "PaperQuery/1.0 (Wikipedia API client)" } },
      cfg.timeoutMs,
    );
    if (!r.ok) return { papers: [], note: `http_${r.status}`, toolName: "wikipedia" };
    const json = await r.json();
    const rows = Array.isArray(json?.query?.search) ? json.query.search : [];
    const papers = rows.map((row) => {
      const title = String(row?.title ?? "").trim();
      const id = String(row?.pageid ?? stableId(title));
      const pageUrl = `https://${cfg.lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
      const summary = decodeHtml(row?.snippet ?? title).slice(0, 1200);
      return {
        paper_id: `wikipedia:${id}`,
        title,
        abstract: summary,
        summary,
        year: row?.timestamp ? Number(String(row.timestamp).slice(0, 4)) || null : null,
        venue: `Wikipedia (${cfg.lang})`,
        published: String(row?.timestamp ?? ""),
        authors: [],
        authors_json: "[]",
        id,
        absUrl: pageUrl,
        pdfUrl: pageUrl,
        source: "wikipedia_web",
        doi: null,
        oa_status: null,
        isReferencedByCount: null,
      };
    }).filter((p) => p.title && p.absUrl);
    return { papers, note: papers.length ? `ok:${papers.length}` : "no-results", toolName: "wikipedia" };
  } catch (e) {
    return { papers: [], note: `err:${String(e?.message || e).slice(0, 100)}`, toolName: "wikipedia" };
  }
}

