/**
 * Elsevier Scopus Search API（合规元数据）。
 * @see https://dev.elsevier.com/documentation/ScopusSearchAPI.wadl
 *
 * 环境变量（勿提交到 Git）：
 * - ELSEVIER_API_KEY：dev.elsevier.com 申请的 API Key（必填）
 * - ELSEVIER_INST_TOKEN：可选，机构 Token（X-ELS-Insttoken），与 Key 组合用于机构权益
 */

const SCOPUS_SEARCH = "https://api.elsevier.com/content/search/scopus";

/** @returns {null | { apiKey: string; instToken: string }} */
export function getElsevierScopusConfig() {
  const apiKey = String(
    process.env.ELSEVIER_API_KEY ?? process.env.SCOPUS_API_KEY ?? process.env.X_ELS_APIKEY ?? "",
  ).trim();
  if (!apiKey) return null;
  const instToken = String(process.env.ELSEVIER_INST_TOKEN ?? "").trim();
  return { apiKey, instToken };
}

/** 弱化破坏 Scopus 查询语法的字符 */
function sanitizeScopusTerm(q) {
  return String(q ?? "")
    .replace(/["{}()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 480);
}

function buildScopusQuery(effectiveQuery) {
  const t = sanitizeScopusTerm(effectiveQuery);
  if (!t) return "";
  const parts = t.split(" ").filter(Boolean);
  if (parts.length <= 1) return `TITLE-ABS-KEY(${t})`;
  return parts.map((p) => `TITLE-ABS-KEY(${p})`).join(" AND ");
}

/** @param {Record<string, unknown>} e */
function mapScopusEntry(e) {
  const title = String(e["dc:title"] ?? "").trim();
  if (!title) return null;

  let doi = String(e["prism:doi"] ?? "").trim().toLowerCase();
  if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi)) doi = "";

  const desc = String(e["dc:description"] ?? "").trim();
  const cover = String(e["prism:coverDate"] ?? "").trim();
  const year = cover.length >= 4 ? Number(cover.slice(0, 4)) : null;
  const venue = String(e["prism:publicationName"] ?? "").trim() || "Scopus";

  const authors = [];
  const au = e.author;
  if (Array.isArray(au)) {
    for (const a of au) {
      const n = String(a?.authname ?? a?.["given-name"] ?? "").trim();
      if (n) authors.push(n);
    }
  }
  const creator = String(e["dc:creator"] ?? "").trim();
  if (!authors.length && creator) authors.push(creator);

  const citeRaw = e["citedby-count"];
  const cite = citeRaw != null && citeRaw !== "" ? Number(citeRaw) : null;

  const scopusId = String(e["dc:identifier"] ?? "")
    .replace(/^SCOPUS_ID:/i, "")
    .trim();
  const selfLink = Array.isArray(e.link)
    ? e.link.find((l) => l && l["@ref"] === "self" && typeof l["@href"] === "string")
    : null;
  const absApi = selfLink?.["@href"] ? String(selfLink["@href"]).replace(/^http:/, "https:") : "";

  const landing = doi
    ? `https://doi.org/${encodeURIComponent(doi)}`
    : absApi || (scopusId ? `https://www.scopus.com/inward/record.url?partnerID=HzOxMe3b&scp=${scopusId}` : "");

  const id = doi ? doi.replace(/\//g, "_") : scopusId ? `scp_${scopusId}` : `scopus:${title.slice(0, 40)}`;

  return {
    paper_id: doi ? `crossref:${doi}` : `scopus:${scopusId || id}`,
    doi: doi || null,
    title,
    abstract: desc,
    year: Number.isFinite(year) ? year : null,
    venue,
    oa_status: null,
    authors_json: JSON.stringify(authors),
    authors,
    summary: desc || `${title}（Scopus）`,
    published: cover || (year ? `${year}-01-01` : ""),
    id,
    absUrl: landing || absApi,
    pdfUrl: landing || absApi,
    source: "scopus",
    isReferencedByCount: Number.isFinite(cite) ? cite : null,
  };
}

/**
 * @param {string} query
 * @param {number} perPage
 */
export async function fetchScopusWorks(query, perPage = 12) {
  const cfg = getElsevierScopusConfig();
  if (!cfg) return [];

  const scopusQ = buildScopusQuery(query);
  if (!scopusQ) return [];

  const count = Math.min(25, Math.max(1, Math.floor(perPage)));
  const url = new URL(SCOPUS_SEARCH);
  url.searchParams.set("query", scopusQ);
  url.searchParams.set("count", String(count));
  url.searchParams.set("sort", "relevancy");
  url.searchParams.set("view", "STANDARD");

  const headers = {
    Accept: "application/json",
    "X-ELS-APIKey": cfg.apiKey,
  };
  if (cfg.instToken) headers["X-ELS-Insttoken"] = cfg.instToken;

  const res = await fetch(url.toString(), { method: "GET", headers });
  const text = await res.text();
  if (!res.ok) {
    console.warn("[scopus] HTTP", res.status, text.slice(0, 200));
    return [];
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.warn("[scopus] invalid JSON");
    return [];
  }

  const se = json?.["service-error"];
  if (se) {
    console.warn("[scopus] service-error", JSON.stringify(se).slice(0, 300));
    return [];
  }

  const sr = json?.["search-results"];
  const rawEntry = sr?.entry;
  const entries = Array.isArray(rawEntry) ? rawEntry : rawEntry ? [rawEntry] : [];

  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const p = mapScopusEntry(/** @type {Record<string, unknown>} */ (e));
    if (p) out.push(p);
  }
  return out;
}
