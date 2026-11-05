import { EPS_SOURCE, epsDocument } from "./patentSourcePolicy.js";

export function extractEpNumbers(text) {
  return [...new Set((String(text ?? "").match(/\bEP[\s-]*\d{6,7}[\s-]*(?:NW)?[AB][12389]\b/gi) ?? []).map(s => epsDocument(s)?.patentNumber).filter(Boolean))];
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

async function fetchXml(number, signal, fetchImpl) {
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
  return parseEpsXml(Buffer.concat(chunks).toString("utf8"), number);
}

// 搜索引擎仅定位 EPS 页面；展示的题录和正文必须重新从 EPS 官方 XML 获取、核对编号。
export async function fetchEpsPatentPapers(query, max, { signal, discover, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("eps_timeout")), 30000);
  const limit = Math.min(24, Math.max(1, Number(max) || 20));
  try {
    const numbers = extractEpNumbers(query);
    if (!numbers.length && discover && !controller.signal.aborted) {
      const found = await abortable(discover(`${String(query).slice(0, 400)} site:data.epo.org/publication-server`, limit, controller.signal), controller.signal);
      for (const p of found?.papers ?? []) {
        try {
          const u = new URL(p.absUrl);
          if (u.protocol !== "https:" || u.hostname !== "data.epo.org" || !u.pathname.startsWith("/publication-server/")) continue;
          numbers.push(...extractEpNumbers(decodeURIComponent(u.href) + " " + p.title + " " + (p.summary ?? "")));
        } catch { /* 忽略非官方入口。 */ }
      }
    }
    const candidates = [...new Set(numbers)].slice(0, limit);
    const rows = new Array(candidates.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (next < candidates.length && !controller.signal.aborted) {
        const i = next++;
        try { rows[i] = await fetchXml(candidates[i], controller.signal, fetchImpl); } catch { /* 无原文则不展示，不回退其他渠道。 */ }
      }
    }));
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const papers = rows.filter(Boolean);
    return { papers, note: papers.length ? `eps_verified:${papers.length}` : "eps_no_verified_documents", toolName: EPS_SOURCE.id };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
