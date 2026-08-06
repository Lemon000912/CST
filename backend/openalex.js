/**
 * OpenAlex Works 检索（开放、合规），扩大「网页」渠道题录与摘要覆盖面。
 * @see https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
 */

/** @param {Record<string, number[]>|null|undefined} inv */
function abstractFromInvertedIndex(inv) {
  if (!inv || typeof inv !== "object") return "";
  let max = -1;
  for (const positions of Object.values(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === "number" && p > max) max = p;
    }
  }
  if (max < 0) return "";
  const buf = new Array(max + 1);
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === "number" && pos >= 0 && pos <= max) buf[pos] = word;
    }
  }
  return buf
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {object} w OpenAlex work */
function mapWork(w) {
  const idUrl = String(w.id ?? "").trim();
  const wid = idUrl.includes("/") ? idUrl.split("/").pop() : idUrl;
  if (!wid || !wid.startsWith("W")) return null;

  let doi = null;
  const dr = w.doi;
  if (typeof dr === "string" && dr.trim()) {
    doi = dr.replace(/^https?:\/\/doi\.org\//i, "").trim().toLowerCase();
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) doi = null;
  }

  const title = String(w.display_name ?? w.title ?? "").trim();
  if (!title) return null;

  const abstract =
    abstractFromInvertedIndex(w.abstract_inverted_index) ||
    String(w.abstract ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const authors = (Array.isArray(w.authorships) ? w.authorships : [])
    .map((a) => String(a?.author?.display_name ?? "").trim())
    .filter(Boolean);

  const year = typeof w.publication_year === "number" ? w.publication_year : null;
  const published = year ? `${year}-01-01` : "";

  const venue = String(w.primary_location?.source?.display_name ?? "").trim() || "OpenAlex";
  const landing =
    String(w.primary_location?.landing_page_url ?? "").trim() ||
    String(w.best_oa_location?.landing_page_url ?? "").trim() ||
    (doi ? `https://doi.org/${encodeURIComponent(doi)}` : idUrl);
  const pdfish =
    String(w.best_oa_location?.pdf_url ?? "").trim() ||
    String(w.open_access?.oa_url ?? "").trim() ||
    landing;

  const cite = Number(w.cited_by_count);
  const id = doi ? doi.replace(/\//g, "_") : wid;

  return {
    paper_id: doi ? `crossref:${doi}` : `openalex:${wid}`,
    doi,
    title,
    abstract,
    year,
    venue,
    oa_status: w.open_access?.is_oa ? "OA" : null,
    authors_json: JSON.stringify(authors),
    authors,
    summary: abstract || `${title}（OpenAlex，摘要可能为空）`,
    published,
    id,
    absUrl: landing || idUrl,
    pdfUrl: pdfish || landing,
    source: "openalex",
    isReferencedByCount: Number.isFinite(cite) ? cite : null,
  };
}

export async function fetchOpenAlexWorks(query, perPage = 12) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const n = Math.min(35, Math.max(1, Number(perPage) || 12));
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q.slice(0, 500))}&per_page=${n}`;
  const mail = String(process.env.OPENALEX_CONTACT_EMAIL ?? "quantum-pinnacle@local").trim().slice(0, 120);
  try {
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `XiCai/1.0 (mailto:${mail})`,
      },
    });
    if (!r.ok) {
      console.warn("[openalex] HTTP", r.status);
      return [];
    }
    const j = await r.json();
    const results = j?.results ?? [];
    const out = [];
    for (const w of results) {
      const m = mapWork(w);
      if (m) out.push(m);
    }
    return out;
  } catch (e) {
    console.warn("[openalex] error", e?.message || e);
    return [];
  }
}

/** OpenAlex 专利类型 work → paper */
function mapPatentWork(w) {
  const idUrl = String(w.id ?? "").trim();
  const wid = idUrl.includes("/") ? idUrl.split("/").pop() : idUrl;
  if (!wid) return null;

  let doi = null;
  const dr = w.doi;
  if (typeof dr === "string" && dr.trim()) {
    doi = dr.replace(/^https?:\/\/doi\.org\//i, "").trim().toLowerCase();
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) doi = null;
  }

  const title = String(w.display_name ?? w.title ?? "").trim();
  if (!title) return null;

  const abstract =
    abstractFromInvertedIndex(w.abstract_inverted_index) ||
    String(w.abstract ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const inventors = (Array.isArray(w.authorships) ? w.authorships : [])
    .map((a) => String(a?.author?.display_name ?? "").trim())
    .filter(Boolean);
  const assignees = (Array.isArray(w.assignees) ? w.assignees : [])
    .map((a) => String(a?.display_name ?? a?.name ?? "").trim())
    .filter(Boolean);

  const authors = inventors.length ? inventors : assignees;

  const year = typeof w.publication_year === "number" ? w.publication_year : null;
  const published = year ? `${year}-01-01` : "";
  const venue = String(w.primary_location?.source?.display_name ?? "").trim() || `专利 (${assignees[0] || "OpenAlex"})`;

  const landing =
    String(w.primary_location?.landing_page_url ?? "").trim() ||
    String(w.best_oa_location?.landing_page_url ?? "").trim() ||
    (doi ? `https://doi.org/${encodeURIComponent(doi)}` : idUrl);

  const pid = `openalex_patent:${wid}`;

  const patentNumber = String(w.ids?.patent_id ?? "").trim() || "";

  return {
    paper_id: pid,
    doi,
    title,
    abstract,
    year,
    venue: venue || "Patent (OpenAlex)",
    oa_status: w.open_access?.is_oa ? "OA" : null,
    authors_json: JSON.stringify(authors),
    authors,
    summary: abstract || `${title}（OpenAlex专利${patentNumber ? `: ${patentNumber}` : ""}）`,
    published,
    id: doi ? doi.replace(/\//g, "_") : wid,
    absUrl: landing || idUrl,
    pdfUrl: landing,
    source: "openalex_patent",
    isReferencedByCount: Number(w.cited_by_count) || null,
    patentNumber: patentNumber || undefined,
  };
}

export async function fetchOpenAlexPatents(query, perPage = 15) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const n = Math.min(35, Math.max(1, Number(perPage) || 15));
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q.slice(0, 500))}&filter=type:patent&per_page=${n}`;
  const mail = String(process.env.OPENALEX_CONTACT_EMAIL ?? "quantum-pinnacle@local").trim().slice(0, 120);
  try {
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `XiCai/1.0 (mailto:${mail})`,
      },
    });
    if (!r.ok) {
      console.warn("[openalex:patents] HTTP", r.status);
      return [];
    }
    const j = await r.json();
    const results = j?.results ?? [];
    const out = [];
    for (const w of results) {
      const m = mapPatentWork(w);
      if (m) out.push(m);
    }
    return out;
  } catch (e) {
    console.warn("[openalex:patents] error", e?.message || e);
    return [];
  }
}
