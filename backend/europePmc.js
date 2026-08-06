/**
 * Europe PMC 开放 REST 检索（生物医药等文献网，免密钥；请设置 OPENALEX_CONTACT_EMAIL 作礼貌 User-Agent）。
 * @see https://europepmc.org/RestfulWebService
 */

/** @param {string} s */
function splitAuthors(s) {
  const t = String(s ?? "").trim();
  if (!t) return [];
  return t
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 40);
}

/** @param {Record<string, unknown>} row */
function mapResultRow(row) {
  const title = String(row.title ?? "").trim();
  if (!title) return null;
  const pmid = String(row.pmid ?? row.id ?? "").trim();
  const doi =
    typeof row.doi === "string" && /^10\.\d{4,9}\//i.test(row.doi)
      ? row.doi.trim().toLowerCase()
      : null;
  const year = row.pubYear != null ? Number(row.pubYear) : null;
  const y = Number.isFinite(year) ? year : null;
  const abs = String(row.abstractText ?? "").trim().slice(0, 3500);
  const authors = splitAuthors(row.authorString);
  const journal = String(row.journalTitle ?? "").trim();
  const cite = Number(row.citedByCount);

  let absUrl = "";
  if (Array.isArray(row.fullTextUrlList?.fullTextUrl)) {
    const urls = row.fullTextUrlList.fullTextUrl;
    const prefer = urls.find((u) => String(u?.availabilityCode ?? "") === "OA" && typeof u?.url === "string");
    const any = urls.find((u) => typeof u?.url === "string");
    absUrl = String((prefer ?? any)?.url ?? "").trim();
  }
  if (!absUrl && doi) absUrl = `https://doi.org/${encodeURIComponent(doi)}`;
  if (!absUrl && pmid) absUrl = `https://europepmc.org/article/MED/${encodeURIComponent(pmid)}`;

  const pid = doi ? doi.replace(/\//g, "_") : pmid ? `pmid_${pmid}` : `epmc:${stableHex(title)}`;

  return {
    paper_id: doi ? `crossref:${doi}` : `europepmc:${pmid || pid}`,
    doi,
    title,
    abstract: abs,
    year: y,
    venue: journal || "Europe PMC",
    oa_status: row.isOpenAccess === "Y" ? "OA" : null,
    authors_json: JSON.stringify(authors),
    authors,
    summary: abs || `${title}（Europe PMC）`,
    published: y ? `${y}-01-01` : "",
    id: doi || pmid || pid,
    absUrl,
    pdfUrl: absUrl,
    source: "europepmc",
    isReferencedByCount: Number.isFinite(cite) ? cite : null,
  };
}

function stableHex(title) {
  let h = 0;
  const s = String(title).slice(0, 200);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 12);
}

/**
 * @param {string} query
 * @param {number} perPage
 */
export async function fetchEuropePmcWorks(query, perPage = 12) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const n = Math.min(35, Math.max(1, Number(perPage) || 12));
  const mail = String(process.env.OPENALEX_CONTACT_EMAIL ?? "quantum-pinnacle@local").trim().slice(0, 120);
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q.slice(0, 800))}&format=json&resultType=core&pageSize=${n}`;
  try {
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `XiCai/1.0 EuropePMC (mailto:${mail})`,
      },
    });
    if (!r.ok) {
      console.warn("[europepmc] HTTP", r.status);
      return [];
    }
    const j = await r.json();
    const rows = j?.resultList?.result ?? [];
    const out = [];
    for (const row of rows) {
      const m = mapResultRow(row);
      if (m) out.push(m);
    }
    return out;
  } catch (e) {
    console.warn("[europepmc] error", e?.message || e);
    return [];
  }
}
