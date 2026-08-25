/** CORE API v3 学术开放获取检索适配器（网页渠道）。 */
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const BASE_URL = "https://api.core.ac.uk/v3/search/works";

export function getCoreSearchConfig() {
  const apiKey = String(process.env.CORE_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const timeoutMs = Math.min(60_000, Math.max(5000, Number(process.env.CORE_TIMEOUT_MS) || 15_000));
  const maxResults = Math.min(50, Math.max(1, Number(process.env.CORE_MAX_RESULTS) || 20));
  return { apiKey, timeoutMs, maxResults };
}

function firstUrl(row) {
  const candidates = [
    row?.downloadUrl,
    row?.sourceFulltextUrls?.[0],
    row?.urls?.[0],
    row?.fullText?.url,
    row?.id ? `https://core.ac.uk/works/${row.id}` : "",
  ];
  return candidates.map((x) => String(x ?? "").trim()).find((x) => /^https?:\/\//i.test(x)) || "";
}

function authorsOf(row) {
  const a = Array.isArray(row?.authors) ? row.authors : [];
  return a.map((x) => typeof x === "string" ? x : x?.name || x?.fullName || "").map(String).filter(Boolean).slice(0, 24);
}

/** @returns {Promise<{papers: object[]; note: string; toolName: string}>} */
export async function fetchCoreWebPapers(query, max) {
  const q = String(query ?? "").trim();
  const cfg = getCoreSearchConfig();
  if (!q) return { papers: [], note: "empty-query", toolName: "core" };
  if (!cfg) return { papers: [], note: "not-configured", toolName: "core" };
  const limit = Math.min(cfg.maxResults, Math.max(1, Number(max) || cfg.maxResults));
  const params = new URLSearchParams({ q: q.slice(0, 500), limit: String(limit) });
  try {
    const r = await fetchWithTimeout(
      `${BASE_URL}?${params.toString()}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${cfg.apiKey}` } },
      cfg.timeoutMs,
    );
    if (!r.ok) return { papers: [], note: `http_${r.status}`, toolName: "core" };
    const json = await r.json();
    const rows = Array.isArray(json?.results) ? json.results : Array.isArray(json?.data) ? json.data : [];
    const papers = rows.map((row) => {
      const authors = authorsOf(row);
      const title = String(row?.title ?? "").trim();
      const abstract = String(row?.abstract ?? row?.description ?? "").trim().slice(0, 4000);
      const doi = String(row?.doi ?? "").trim() || null;
      const id = String(row?.id ?? doi ?? title).trim();
      const absUrl = firstUrl(row);
      return {
        paper_id: `core:${id}`,
        doi,
        title,
        abstract,
        summary: abstract || title,
        year: Number(row?.yearPublished ?? row?.year ?? 0) || null,
        venue: String(row?.publisher ?? row?.journals?.[0]?.title ?? "CORE").slice(0, 240),
        published: String(row?.yearPublished ?? ""),
        authors,
        authors_json: JSON.stringify(authors),
        id,
        absUrl,
        pdfUrl: absUrl,
        source: "core",
        oa_status: "open",
        isReferencedByCount: Number(row?.citationCount ?? 0) || 0,
      };
    }).filter((p) => p.title && p.absUrl);
    return { papers, note: papers.length ? `ok:${papers.length}` : "no-results", toolName: "core" };
  } catch (e) {
    return { papers: [], note: `err:${String(e?.message || e).slice(0, 100)}`, toolName: "core" };
  }
}

