const FIELDS = ['material_name', 'symmetry_phase', 'synthesis_method', 'structure_descriptor'];
const STOP = new Set('a an and are as at be been being by for from how in into is it of on or that the their these this to using use used via was were what which with without research study studies review reviews method methods approach approaches based based-on investigate investigation effects effect properties property performance preparation synthesis application applications'.split(' '));
const ELEMENTS = new Set(['Al','Fe','Cu','Ti','Si','Mg','Zn','Ni','Co','Cr','Mn','Sn','Pb','Ag','Au','Pt','Pd','Li','Na','Ca','In','As','Ga','Ge','Mo','Nb','Ta','W','V','B','C','N','O','S','P']);
export function databaseSearchFastEnabled() { return process.env.DB_SEARCH_FAST_MODE === '1'; }
export function extractFastSearchTerms(query) {
  const words = String(query ?? '').match(/[\p{Script=Han}]{2,}|[A-Za-z0-9][A-Za-z0-9+.-]*/gu) || [];
  const seen = new Set();
  return words.map(w => w.replace(/[.+-]+$/, '')).filter(w => {
    const key = w.toLowerCase();
    if (!w || seen.has(key) || (STOP.has(key) && !ELEMENTS.has(w)) || (w.length < 2 && !ELEMENTS.has(w))) return false;
    seen.add(key); return true;
  }).slice(0, 12);
}
export function exactDoi(query) {
  const hit = String(query ?? '').match(/(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s<>"']+)/i);
  return hit ? hit[1].replace(/[.,;]+$/, '') : null;
}
function boundedNumber(value, fallback, min, max) { return Math.min(max, Math.max(min, Number(value) || fallback)); }
function timeoutError() { const e = new Error('database search deadline exceeded'); e.code = '57014'; return e; }
async function connectBefore(pool, deadline) {
  if (!pool) return null;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(timeoutError()); }, remaining);
    pool.connect().then(client => {
      clearTimeout(timer);
      if (expired) client.release(); else resolve(client);
    }, error => { clearTimeout(timer); if (!expired) reject(error); });
  });
}
async function readPhase(client, sql, values, milliseconds) {
  if (milliseconds <= 0) throw timeoutError();
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '500ms', true)", [String(Math.max(1, Math.floor(milliseconds)))]);
    return (await client.query(sql, values)).rows;
  } finally {
    await client.query('ROLLBACK');
  }
}
export function buildCandidateQuery(terms, { strict = true, limit = 300 } = {}) {
  const long = terms.filter(t => t.length >= 3);
  const short = terms.filter(t => t.length < 3);
  const selected = strict ? [...long.slice(0, 2), ...short.slice(0, 1)] : (long.length ? long.slice(0, 2) : short.slice(0, 1));
  if (!selected.length) return null;
  const values = [];
  const groups = selected.map(term => {
    // Short chemical symbols require a word boundary instead of matching inside every word.
    const shortTerm = term.length < 3;
    const escaped = shortTerm ? term.replace(/[.*+?^\$\{\}()|[\]\\]/g, '\\$&') : term.replace(/[\\%_]/g, '\\$&');
    values.push(shortTerm ? '\\m' + escaped + '\\M' : '%' + escaped + '%');
    const parameter = '$' + values.length;
    return '(' + FIELDS.map(field => field + (shortTerm ? ' ~* ' : ' ILIKE ') + parameter).join(' OR ') + ')';
  });
  values.push(Math.max(1, Math.min(600, Number(limit) || 300)));
  return { text: 'SELECT * FROM papers WHERE ' + groups.join(strict ? ' AND ' : ' OR ') + ' LIMIT $' + values.length, values };
}
export function rankFastCandidates(rows, terms, limit) {
  const score = row => {
    let result = 0;
    for (const [index, field] of FIELDS.entries()) {
      const text = String(row[field] ?? '').toLowerCase();
      for (const term of terms) {
        const t = term.toLowerCase();
        const matched = t.length < 3 ? new RegExp('(?:^|[^a-z0-9])' + t.replace(/[.*+?^\$\{\}()|[\]\\]/g, '\\$&') + '(?:$|[^a-z0-9])','i').test(text) : text.includes(t);
        if (matched) result += index === 0 ? 4 : 1;
      }
    }
    return result;
  };
  const unique = new Map();
  for (const row of rows) if (!unique.has(row.paper_id)) unique.set(row.paper_id, row);
  return [...unique.values()].map(row => ({ row, score: score(row) }))
    .sort((a,b) => b.score - a.score || (Number(b.row.year)||0) - (Number(a.row.year)||0) || String(a.row.paper_id).localeCompare(String(b.row.paper_id)))
    .slice(0, limit).map(item => item.row);
}
export async function searchPapersFast(pool, query, limit = 50) {
  const cap = boundedNumber(limit, 50, 1, 220);
  const budget = boundedNumber(process.env.DB_SEARCH_BUDGET_MS, 7000, 1000, 15000);
  const deadline = Date.now() + budget;
  let client; const rows = [];
  try {
    client = await connectBefore(pool, deadline);
    if (!client) return [];
    const doi = exactDoi(query);
    if (doi) return await readPhase(client, 'SELECT * FROM papers WHERE doi = ANY($1::text[]) LIMIT $2', [[...new Set([doi, doi.toLowerCase()])], cap], deadline - Date.now());
    const terms = extractFastSearchTerms(query);
    if (!terms.length) return [];
    const candidateLimit = Math.min(600, Math.max(120, cap * 3));
    for (const strict of [true, false]) {
      if (rows.length >= Math.min(cap, 12) || Date.now() >= deadline) break;
      const plan = buildCandidateQuery(terms, { strict, limit: candidateLimit });
      if (!plan) break;
      try {
        const remaining = deadline - Date.now();
        rows.push(...await readPhase(client, plan.text, plan.values, strict ? Math.min(3500, remaining) : remaining));
      } catch (error) {
        if (error.code !== '57014' && error.code !== '55P03') throw error;
        console.warn('[database-fast] papers phase timed out', { strict });
      }
      if (terms.length === 1 && rows.length) break;
    }
    return rankFastCandidates(rows, terms, cap);
  } catch (error) {
    console.warn('[database-fast] papers query failed', { code: error.code || 'connection' });
    if (rows.length) return rankFastCandidates(rows, extractFastSearchTerms(query), cap);
    return [];
  } finally { client?.release(); }
}
export async function searchDoiFast(pool, query, limit = 50) {
  const doi = exactDoi(query);
  if (!doi || !pool) return [];
  const deadline = Date.now() + 2500; let client;
  try {
    client = await connectBefore(pool, deadline);
    return await readPhase(client, 'SELECT * FROM doi_records WHERE doi = ANY($1::text[]) LIMIT $2', [[...new Set([doi, doi.toLowerCase()])], boundedNumber(limit,50,1,220)], deadline-Date.now());
  } catch (error) {
    console.warn('[database-fast] DOI query failed', { code: error.code || 'connection' });
    return [];
  } finally { client?.release(); }
}
