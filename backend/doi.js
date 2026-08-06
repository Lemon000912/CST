/**
 * DOI 规范化与从自由文本中提取（用于本地库与 Crossref 精确命中）。
 */

export function normalizeDoiString(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

/** 从整段检索词里抓第一个疑似 DOI（10.xxxx/…，后缀允许 arXiv 等常见字符） */
export function extractDoiCandidate(text) {
  const t = normalizeDoiString(text);
  const m = t.match(/\b10\.\d{4,9}\/\S+/i);
  if (!m) return null;
  let d = m[0].replace(/[.,;)"'\]]+$/, "");
  d = normalizeDoiString(d);
  return /^10\.\d{4,9}\//.test(d) ? d : null;
}
