const ARXIV_API = "http://export.arxiv.org/api/query";

/** arXiv 建议脚本类访问间隔约 ≥3s；略放宽以减少边界竞态 */
const ARXIV_MIN_GAP_MS = 3600;
const ARXIV_MAX_RETRIES = 4;

let lastArxivRequestEndMs = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function paceArxiv() {
  const wait = ARXIV_MIN_GAP_MS - (Date.now() - lastArxivRequestEndMs);
  if (wait > 0) await sleep(wait);
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArxivAtom(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const id = extractTag(block, "id");
    const title = extractTag(block, "title");
    const summary = extractTag(block, "summary");
    const published = extractTag(block, "published");
    const authors = [];
    const authorRe = /<author>\s*<name>([^<]*)<\/name>/gi;
    let am;
    while ((am = authorRe.exec(block))) authors.push(am[1].trim());
    const absMatch = id.match(/arxiv\.org\/abs\/([^/]+)/i);
    const arxivId = absMatch ? absMatch[1] : id;
    const year = published ? Number(published.slice(0, 4)) || null : null;
    entries.push({
      paper_id: `arxiv:${arxivId}`,
      arxiv_id: arxivId,
      doi: null,
      title,
      abstract: summary,
      year,
      venue: "arXiv",
      oa_status: "OA",
      authors_json: JSON.stringify(authors),
      authors,
      summary,
      published,
      id: arxivId,
      absUrl: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
      source: "arxiv",
    });
  }
  return entries;
}

/** arXiv sortBy；citations 无免费字段时退回 relevance */
export function mapArxivSort(sort) {
  if (sort === "submittedDate" || sort === "lastUpdatedDate") return sort;
  return "relevance";
}

/**
 * @param {object} opts
 * @param {string} opts.searchQuery - 已拼好的 search_query 片段（未整体 encode 前的逻辑串）
 */
export async function fetchArxiv({ searchQuery, max = 12, sort = "relevance" }) {
  const sortBy = mapArxivSort(sort);
  const q = encodeURIComponent(searchQuery);
  const url = `${ARXIV_API}?search_query=${q}&start=0&max_results=${max}&sortBy=${sortBy}&sortOrder=descending`;
  const headers = {
    "User-Agent": "PaperQuery/1.0 (research paper UI; honors arXiv rate guidelines)",
  };

  let lastStatus = 0;
  for (let attempt = 0; attempt < ARXIV_MAX_RETRIES; attempt++) {
    await paceArxiv();
    const r = await fetch(url, { headers });
    lastStatus = r.status;

    if (r.ok) {
      const xml = await r.text();
      lastArxivRequestEndMs = Date.now();
      return parseArxivAtom(xml);
    }

    await r.text().catch(() => {});
    lastArxivRequestEndMs = Date.now();

    const retryable = r.status === 429 || r.status === 503;
    if (retryable && attempt < ARXIV_MAX_RETRIES - 1) {
      const ra = r.headers.get("retry-after");
      let extraMs = 2000 * 2 ** attempt;
      if (ra) {
        const n = Number(ra);
        if (Number.isFinite(n)) extraMs = Math.max(extraMs, n * 1000);
      }
      extraMs = Math.min(extraMs, 45_000);
      await sleep(extraMs);
      continue;
    }

    const err = new Error(
      retryable
        ? `arXiv 多次限流（HTTP ${r.status}），请 1～2 分钟后再试。`
        : `arXiv HTTP ${r.status}`,
    );
    err.code = "ARXIV_HTTP";
    err.status = r.status;
    throw err;
  }

  const err = new Error(`arXiv HTTP ${lastStatus}`);
  err.code = "ARXIV_HTTP";
  err.status = lastStatus;
  throw err;
}

/**
 * 将用户关键词与字段 author:/year: 等拼装为 arXiv search_query（S-1 子集）
 * @param {string} raw
 * @param {'ti'|'abs'|'all'} field
 */
export function buildArxivSearchQuery(raw, field) {
  let s = String(raw ?? "").trim();
  const clauses = [];

  s = s.replace(/author:\s*"([^"]+)"/gi, (_, name) => {
    const n = String(name).trim();
    if (n) clauses.push(`au:${n}`);
    return " ";
  });
  s = s.replace(/author:\s*(\S+)/gi, (_, name) => {
    const n = String(name).trim();
    if (n) clauses.push(`au:${n}`);
    return " ";
  });
  s = s.replace(/year:\s*(\d{4})/gi, (_, y) => {
    clauses.push(`submittedDate:[${y}01010000+TO+${y}12312359]`);
    return " ";
  });

  const phrases = [];
  s = s.replace(/"([^"]+)"/g, (_, p) => {
    phrases.push(String(p).trim());
    return " ";
  });
  s = s.replace(/\s+/g, " ").trim();

  for (const p of phrases) {
    if (p) clauses.push(`${field}:"${p.replace(/"/g, "")}"`);
  }

  const text = s;
  const core = text.length ? `${field}:${text}` : "";
  if (clauses.length && core) return `${clauses.join("+AND+")}+AND+${core}`;
  if (clauses.length) return clauses.join("+AND+");
  if (core) return core;
  return `${field}:all`;
}
