/**
 * 将 synthesisPlan.extractedData 与摘录正文中的数值，挂到每条 paper 的 dataPoints 上。
 */

import { normalizeExtractedData } from "./synthesisExtract.js";

const MAX_PER_PAPER = 16;
const MAX_FROM_SUMMARY = 10;

/**
 * @param {string} ref
 * @returns {number | null} 1-based
 */
function parseBracketIndex(ref) {
  const s = String(ref ?? "").trim();
  const m = s.match(/\[(\d{1,3})\]/);
  if (m) return Number(m[1]);
  if (/^\d{1,3}$/.test(s)) return Number(s);
  return null;
}

/**
 * @param {object} p
 * @param {object} row
 */
function paperMatchesSourceRef(p, papers, row, oneBasedHint) {
  if (oneBasedHint != null) {
    const i = oneBasedHint - 1;
    if (i >= 0 && i < papers.length && papers[i] === p) return true;
  }
  const ref = String(row.source_ref ?? row.ref ?? "").trim();
  if (!ref) return false;
  const doi = String(p.doi ?? "").trim().toLowerCase();
  const url = String(p.absUrl ?? "").trim().toLowerCase();
  const pn = String(p.patentNumber ?? "").trim().toLowerCase();
  const r = ref.toLowerCase();
  if (doi && r.includes(doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""))) return true;
  if (url && r.includes(url.slice(0, Math.min(48, url.length)))) return true;
  if (pn && r.includes(pn)) return true;
  const ctx = String(row.context ?? "").trim();
  if (ctx.length >= 8) {
    const sum = String(p.summary ?? p.abstract ?? "");
    if (sum.includes(ctx.slice(0, Math.min(40, ctx.length)))) return true;
  }
  return false;
}

function dataPointKey(row) {
  return `${String(row.metric ?? "").trim()}|${String(row.value ?? "").trim()}|${String(row.unit ?? "").trim()}`;
}

/**
 * @param {object[]} existing
 * @param {object} row
 * @param {string} via
 */
function pushPoint(existing, row, via) {
  const metric = String(row.metric ?? "").trim();
  const value = String(row.value ?? "").trim();
  if (!metric && !value) return;
  const key = dataPointKey({ metric, value, unit: row.unit });
  if (existing.some((x) => dataPointKey(x) === key)) return;
  existing.push({
    metric: metric || "数值",
    value: value || "—",
    ...(String(row.unit ?? "").trim() ? { unit: String(row.unit).trim() } : {}),
    ...(String(row.condition ?? row.material ?? "").trim()
      ? { condition: String(row.condition ?? row.material).trim().slice(0, 120) }
      : {}),
    ...(String(row.context ?? "").trim()
      ? { context: String(row.context).trim().slice(0, 200) }
      : {}),
    via,
  });
}

/**
 * 从摘录文本用规则抽取可量化片段（与 paperChart 后备类似，输出 dataPoints 形态）
 * @param {string} summary
 */
export function extractDataPointsFromSummary(summary) {
  const text = String(summary ?? "");
  if (!text.trim()) return [];
  const out = [];
  const seen = new Set();

  const add = (metric, value, unit, context) => {
    const row = { metric, value, unit, context };
    const k = dataPointKey(row);
    if (seen.has(k)) return;
    seen.add(k);
    pushPoint(out, row, "summary");
  };

  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*[％%]/g)) {
    add("比例/效率", m[1], "%", m[0]);
    if (out.length >= MAX_FROM_SUMMARY) return out.slice(0, MAX_FROM_SUMMARY);
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*eV\b/gi)) {
    add("带隙/能量", m[1], "eV", m[0]);
    if (out.length >= MAX_FROM_SUMMARY) return out.slice(0, MAX_FROM_SUMMARY);
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:mA\/cm²|mW\/cm²|W\/cm²|W\/m²|S\/cm|Ω·cm)/gi)) {
    add("电学指标", m[1], m[0].replace(/[\d.]+/, "").trim() || m[0], m[0]);
    if (out.length >= MAX_FROM_SUMMARY) return out.slice(0, MAX_FROM_SUMMARY);
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:nm|μm|mm|cm|°C|K\b|MPa|GPa|kW|MW|万吨|亿元|万元|吨|千克|g\/)/gi)) {
    add("物理量", m[1], m[0].replace(/^[\d.]+/, "").trim() || m[0], m[0]);
    if (out.length >= MAX_FROM_SUMMARY) return out.slice(0, MAX_FROM_SUMMARY);
  }
  for (const m of text.matchAll(/(?:约|达|至|为|是)\s*(\d+(?:\.\d+)?)\s*(?:万|亿|千)?/g)) {
    const v = m[1];
    if (Number(v) >= 1900 && Number(v) <= 2100) continue;
    add("数值", v, "", m[0]);
    if (out.length >= MAX_FROM_SUMMARY) return out.slice(0, MAX_FROM_SUMMARY);
  }

  return out.slice(0, MAX_FROM_SUMMARY);
}

/**
 * @param {object[]} papers
 * @param {Record<string, unknown> | null | undefined} synthesisPlan
 * @returns {object[]}
 */
export function enrichPapersWithDataPoints(papers, synthesisPlan) {
  const arr = Array.isArray(papers) ? papers.map((p) => ({ ...p })) : [];
  if (!arr.length) return arr;

  const planRows = normalizeExtractedData(
    synthesisPlan && typeof synthesisPlan === "object" ? synthesisPlan.extractedData : [],
  );

  /** @type {Map<number, object[]>} */
  const byIndex = new Map();
  for (const row of planRows) {
    const n = parseBracketIndex(row.source_ref);
    if (n == null || n < 1) continue;
    if (!byIndex.has(n)) byIndex.set(n, []);
    byIndex.get(n).push(row);
  }

  return arr.map((p, idx) => {
    const points = [];
    const oneBased = idx + 1;

    for (const row of byIndex.get(oneBased) ?? []) {
      pushPoint(points, row, "synthesis");
    }
    for (const row of planRows) {
      if (parseBracketIndex(row.source_ref) != null) continue;
      if (paperMatchesSourceRef(p, arr, row, null)) pushPoint(points, row, "synthesis");
    }

    for (const row of extractDataPointsFromSummary(p.summary ?? p.abstract)) {
      if (points.length >= MAX_PER_PAPER) break;
      pushPoint(points, row, row.via || "summary");
    }

    if (points.length) {
      return { ...p, dataPoints: points.slice(0, MAX_PER_PAPER) };
    }
    return p;
  });
}
