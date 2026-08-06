import { extractDoiCandidate, normalizeDoiString } from "./doi.js";

function normAuthors(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    const fam = a?.family;
    const giv = a?.given;
    if (fam && giv) out.push(`${giv} ${fam}`);
    else if (fam) out.push(String(fam));
  }
  return out;
}

function yearFromIssued(issued) {
  const y = issued?.["date-parts"]?.[0]?.[0];
  return typeof y === "number" ? y : null;
}

function mapItem(it) {
  const doi = String(it?.DOI ?? "").trim();
  if (!doi) return null;
  const titleArr = it?.title;
  const title = Array.isArray(titleArr) ? titleArr[0] : String(titleArr ?? "");
  const abstract = String(it?.abstract ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const issued = it?.issued ?? it?.published;
  const year = yearFromIssued(issued);
  const published = year ? `${year}-01-01` : "";
  const venue = String(it?.["container-title"]?.[0] ?? it?.publisher ?? "");
  const authors = normAuthors(it?.author);
  const cite = Number(it?.["is-referenced-by-count"]);
  const id = doi.replace(/\//g, "_");
  return {
    paper_id: `crossref:${doi}`,
    doi,
    title,
    abstract,
    year,
    venue,
    oa_status: null,
    authors_json: JSON.stringify(authors),
    authors,
    summary: abstract || (title ? `${title}（Crossref 元数据，摘要可能为空）` : ""),
    published,
    id,
    absUrl: `https://doi.org/${encodeURIComponent(doi)}`,
    pdfUrl: `https://doi.org/${encodeURIComponent(doi)}`,
    source: "crossref",
    isReferencedByCount: Number.isFinite(cite) ? cite : null,
  };
}

/** 按 DOI 拉取单条 Work（用于检索词中含 DOI 或整段为 DOI） */
export async function fetchCrossrefWorkByDoi(doi) {
  const norm = normalizeDoiString(doi);
  if (!norm || !/^10\.\d{4,9}\/\S+$/i.test(norm)) return [];
  const url = `https://api.crossref.org/works/${encodeURIComponent(norm)}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "PaperQuery/1.0 (mailto:local-dev)",
      Accept: "application/json",
    },
  });
  if (!r.ok) return [];
  const j = await r.json();
  const it = j?.message;
  const m = it ? mapItem(it) : null;
  return m ? [m] : [];
}

export async function fetchCrossrefWorks(query, rows = 8) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const cand = extractDoiCandidate(q);
  const stripped = normalizeDoiString(q);
  if (cand && (stripped === cand || stripped.replace(/\s+/g, "") === cand)) {
    const direct = await fetchCrossrefWorkByDoi(cand);
    if (direct.length) return direct;
  }
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${rows}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "PaperQuery/1.0 (mailto:local-dev)",
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    console.error("[crossref] HTTP", r.status, await r.text().catch(() => ""));
    return [];
  }
  const j = await r.json();
  const items = j?.message?.items ?? [];
  const out = [];
  for (const it of items) {
    const m = mapItem(it);
    if (m) out.push(m);
  }
  return out;
}
