import { EPS_SOURCE, epsDocument } from "./patentSourcePolicy.js";

export function extractEpNumbers(text) {
  return [...new Set((String(text ?? "").match(/\bEP[\s-]*(?:\d{6,7}|\d{1,2}\s+\d{3}\s+\d{3})[\s-]*(?:NW)?[AB][12389]\b/gi) ?? []).map(s => epsDocument(s)?.patentNumber).filter(Boolean))];
}

const EPS_SCOPE = "site:data.epo.org/publication-server ";
export function buildEpsDiscoveryQueries(query, effectiveQuery = "") {
  // 优先复用已经翻译的检索式，避免把中文长问句作为欧洲文献的唯一查询。
  const preferred = String(effectiveQuery || query).replace(/site:\S+/gi, "");
  const words = preferred.match(/[a-z][a-z-]*/gi) ?? [];
  const stop = /^(?:and|or|not|all|ti|abs|the|a|an|of|for|in|on|to|is|are|how|what|which|method|methods|status|state)$/i;
  let terms = [...new Set(words.filter(w => !stop.test(w)).map(w => w.toLowerCase()))];
  if (terms.length < 2) terms = [];
  const variants = [];
  if (terms.length) {
    variants.push(terms.join(" "));
    // 放宽安装环境和接触方式，仍保留对象、失效/被测量和检测目标，供模型区分直接/间接适用性。
    const core = terms.filter(w => !/^(?:underground|buried|non-contact|noncontact|non|contact|remote|real-time|insitu|electrical|electric)$/i.test(w));
    variants.push(core.join(" "));
    const object = terms.some(w => /^(?:cables?|wires?|conductors?)$/.test(w));
    const condition = terms.some(w => /^corro(?:sion|ded|ding|sive)$/.test(w));
    if (object && condition) variants.push("cable corrosion measurement");
  } else variants.push(String(query).trim());
  return [...new Set(variants.filter(Boolean).map(q => EPS_SCOPE + q.slice(0, 128 - EPS_SCOPE.length)))].slice(0, 3);
}

function numbersFromEpsPage(p) {
  try {
    const u = new URL(p.absUrl);
    if (u.protocol !== "https:" || u.hostname !== "data.epo.org" || !u.pathname.startsWith("/publication-server/")) return [];
    const href = decodeURIComponent(u.href);
    const direct = extractEpNumbers(href);
    const route = u.pathname.match(/\/document\/(?:xml|html|pdf)\/(\d{6,7})\/([AB][12389])(?:\/|$)/i);
    const param = epsDocument(`EP${u.searchParams.get("pn")}${u.searchParams.get("ki")}`);
    if (direct.length) return direct;
    if (route) return [epsDocument(`EP${route[1]}${route[2]}`).patentNumber];
    if (param) return [param.patentNumber];
    return extractEpNumbers(p.title);
  } catch { return []; }
}

function plain(xml) {
  return String(xml ?? "").replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|apos);/g, s => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[s])).replace(/\s+/g, " ").trim();
}

export function parseEpsXml(xml, number) {
  const doc = epsDocument(number);
  const root = String(xml).match(/<ep-patent-document\b[^>]*>/i)?.[0] ?? "";
  const attr = n => root.match(new RegExp(`\\b${n}=["']([^"']+)["']`, "i"))?.[1];
  if (!doc || attr("country") !== "EP" || epsDocument(`EP${attr("doc-number")}${attr("kind")}`)?.patentNumber !== doc.patentNumber) return null;
  const titles = [...String(xml).matchAll(/<invention-title\b([^>]*)>([\s\S]*?)<\/invention-title>/gi)];
  const title = plain((titles.find(m => /lang=["']en["']/i.test(m[1])) ?? titles[0])?.[2] || String(xml).match(/<B541>en<\/B541>\s*<B542>([\s\S]*?)<\/B542>/i)?.[1] || String(xml).match(/<B542>([\s\S]*?)<\/B542>/i)?.[1]);
  if (!title) return null;
  const body = String(xml).match(/<abstract\b[^>]*>([\s\S]*?)<\/abstract>/i)?.[1] || String(xml).match(/<description\b[^>]*>([\s\S]*?)<\/description>/i)?.[1] || "";
  const date = attr("date-publ") ?? "";
  return { paper_id: `eps:${doc.patentNumber}`, source: "ddg_patent", patentSource: EPS_SOURCE.id, patentSourceLabel: EPS_SOURCE.label, epsVerified: true, patentNumber: doc.patentNumber, title, absUrl: doc.url, pdfUrl: doc.url, summary: plain(body).slice(0, 6000), published: /^\d{8}$/.test(date) ? `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}` : "", venue: EPS_SOURCE.label, authors: [] };
}

const verifiedXmlCache = new Map();
async function fetchXml(number, signal, fetchImpl, cache) {
  const cached = cache ? verifiedXmlCache.get(number) : null;
  if (cached && cached.until > Date.now()) return { ...cached.paper };
  const doc = epsDocument(number, "xml");
  const res = await fetchImpl(doc.url, { signal, redirect: "error", headers: { Accept: "application/xml,text/xml" } });
  if (!res.ok) return null;
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4_000_000) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const paper = parseEpsXml(Buffer.concat(chunks).toString("utf8"), number);
  if (cache && paper) {
    if (verifiedXmlCache.size >= 256) verifiedXmlCache.delete(verifiedXmlCache.keys().next().value);
    verifiedXmlCache.set(number, { paper, until: Date.now() + 3600000 });
  }
  return paper;
}

async function searchEpsIpc(code, signal, fetchImpl) {
  if (!/^[A-H]\d{2}[A-Z]\d{1,3}\/\d{1,3}$/.test(code)) return [];
  const date = new Date();
  const iso = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  iso.setUTCDate(iso.getUTCDate() + 4 - (iso.getUTCDay() || 7));
  const year = iso.getUTCFullYear();
  const week = Math.ceil((((iso - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7);
  const res = await fetchImpl("https://data.epo.org/publication-server/publications?page=0&size=60&lng=en&sort=publicationDate,desc", {
    method: "POST", signal, redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ publicationNumber: null, applicationNumber: null, ipcSymbol: code, publicationDateRange: { isRange: true, publicationYearStart: 1978, publicationWeekStart: 51, publicationYearEnd: year, publicationWeekEnd: week }, publicationKinds: ["A1", "A2", "B1"] }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const rows = Array.isArray(data.content) ? data.content : [];
  return rows.filter(p => p.countryCode === "EP" && p.publishedByEpo === true && p.pdfFile).map(p => epsDocument(`EP${p.publicationNumber}${p.publicationKind}`)?.patentNumber).filter(Boolean);
}

// 搜索引擎仅定位 EPS 页面；展示的题录和正文必须重新从 EPS 官方 XML 获取、核对编号。
export async function fetchEpsPatentPapers(query, max, { signal, discover, plan, effectiveQuery, fetchImpl = fetch, onDiscovery, cache = false, discoveryTimeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("eps_timeout")), 30000);
  const limit = Math.min(24, Math.max(1, Number(max) || 20));
  try {
    const numbers = extractEpNumbers(`${query} ${effectiveQuery || ""}`);
    if (!numbers.length && !controller.signal.aborted) {
      const searchPlan = plan ? await abortable(plan(query, { effectiveQuery, signal: controller.signal }), controller.signal) : { queries: buildEpsDiscoveryQueries(query, effectiveQuery), ipcCodes: [] };
      const queries = discover ? searchPlan.queries.slice(0, 3) : [];
      const ipcCodes = (searchPlan.ipcCodes ?? []).slice(0, 2);
      const results = await abortable(Promise.allSettled([
        ...queries.map(q => boundedDiscovery(s => discover(q, 50, s), controller.signal, discoveryTimeoutMs)),
        ...ipcCodes.map(code => boundedDiscovery(s => searchEpsIpc(code, s, fetchImpl), controller.signal, discoveryTimeoutMs)),
      ]), controller.signal);
      const pools = [];
      for (let i = 0; i < results.length; i++) {
        const found = results[i].status === "fulfilled" ? results[i].value : null;
        const ipc = i >= queries.length;
        const ids = ipc ? (Array.isArray(found) ? found : []) : (found?.papers ?? []).flatMap(numbersFromEpsPage);
        pools.push([...new Set(ids)]);
        onDiscovery?.({ queryChars: queries[i]?.length ?? 0, provider: ipc ? "eps_ipc" : found?.toolName, results: ipc ? ids.length : found?.papers?.length ?? 0, candidates: new Set(ids).size, note: ipc ? ipcCodes[i - queries.length] : found?.note || "discovery_failed" });
      }
      for (let index = 0; numbers.length < 96 && pools.some(p => index < p.length); index++) {
        for (const pool of pools) if (pool[index] && !numbers.includes(pool[index])) numbers.push(pool[index]);
      }
    }
    const candidates = [...new Set(numbers)].slice(0, 96);
    const rows = new Array(candidates.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (next < candidates.length && !controller.signal.aborted) {
        const i = next++;
        try { rows[i] = await fetchXml(candidates[i], controller.signal, fetchImpl, cache); } catch { /* 无原文则不展示，不回退其他渠道。 */ }
      }
    }));
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const tokens = [...new Set(String(effectiveQuery || query).toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter(t => !/^(?:the|and|for|non|contact|method|methods|status|state|underground|buried)$/.test(t));
    const corrosionIntent = /腐蚀|corros|corrod/i.test(`${query} ${effectiveQuery || ""}`);
    const corrosionText = /腐蚀|corros|corrod|korros/i;
    const measureIntent = /检测|监测|测量|detect|measur|monitor|assess|inspect|sens(?:ing|or)/i.test(`${query} ${effectiveQuery || ""}`);
    const cableIntent = /电线|电缆|cable|wire|conductor/i.test(`${query} ${effectiveQuery || ""}`);
    const methodTitle = /检测|监测|测量|detect|measur|monitor|assess|inspect|sens(?:ing|or)|diagnos|evaluat|checking|determin|reflectometr|eddy.current|electromagnet|ultrason/i;
    const objectText = /cable|wire|conductor|电线|电缆/i;
    const relevant = p => {
      if (!corrosionIntent) return true;
      if (!corrosionText.test(`${p.title} ${p.summary}`)) return false;
      if (measureIntent && !methodTitle.test(p.title)) return false;
      return !cableIntent || corrosionText.test(p.title) || objectText.test(`${p.title} ${p.summary}`);
    };
    const score = p => (corrosionIntent && corrosionText.test(p.title) ? 100 : 0) + (measureIntent && methodTitle.test(p.title) ? 40 : 0) + (cableIntent && objectText.test(p.title) ? 30 : 0) + tokens.reduce((n, t) => n + (p.title.toLowerCase().includes(t) ? 8 : 0) + (p.summary.toLowerCase().includes(t) ? 1 : 0), 0);
    const papers = rows.filter(Boolean).filter(relevant).map(p => ({ ...p, epsRelevanceScore: score(p) })).sort((a, b) => b.epsRelevanceScore - a.epsRelevanceScore).slice(0, limit);
    return { papers, note: papers.length ? `eps_verified:${papers.length}` : "eps_no_verified_documents", toolName: EPS_SOURCE.id };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

async function boundedDiscovery(run, parent, ms) {
  const child = new AbortController();
  const abort = () => child.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(() => child.abort(new Error("eps_discovery_timeout")), Math.max(10, Math.min(8000, Number(ms) || 8000)));
  try { return await abortable(run(child.signal), child.signal); }
  finally { clearTimeout(timer); parent.removeEventListener("abort", abort); child.abort(); }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
