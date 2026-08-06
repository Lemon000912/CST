/**
 * 从题录字段中尽量解析专利公开号/申请号（Google Patents、Lens、正文中的 US/CN/EP/WO 等）。
 * @param {{ title?: string, absUrl?: string, pdfUrl?: string, summary?: string, abstract?: string, patentNumber?: string }} p
 * @returns {string}
 */
export function extractPatentNumberFromPaper(p) {
  const preset = String(p?.patentNumber ?? "").trim();
  if (preset) return preset.slice(0, 64);

  const url = String(p?.absUrl ?? p?.pdfUrl ?? "").trim();
  const blob = [url, p?.title, p?.summary, p?.abstract]
    .map((x) => String(x ?? ""))
    .join(" ")
    .trim();
  if (!blob) return "";

  const gPat = url.match(/(?:patents\.)?google\.[\w.]+\/patent\/([^\/\?#]+)/i);
  if (gPat) {
    try {
      return decodeURIComponent(gPat[1]).replace(/\+/g, " ").slice(0, 64);
    } catch {
      return gPat[1].slice(0, 64);
    }
  }

  const lens = blob.match(/(?:lens\.org|link\.springer\.com)\/[^\s]*patent\/([^\s\/?#]+)/i);
  if (lens) {
    try {
      return decodeURIComponent(lens[1]).slice(0, 64);
    } catch {
      return lens[1].slice(0, 64);
    }
  }

  const pathId = blob.match(/\/(?:patent|publication|doc)\/([A-Z]{2}\d{6,}[^\s\/?#]*)/i);
  if (pathId) return pathId[1].slice(0, 64);

  const m = blob.match(
    /\b(?:US|EP|WO|CN|JP|KR|DE|FR|GB|TW|IN)\s*[-_]?\s*\d[\d,\s]{4,}\s*[A-Z0-9]?\b/gi,
  );
  if (m) {
    const x = m[0].replace(/[\s,]+/g, "").slice(0, 48);
    if (x.length >= 5) return x;
  }
  return "";
}
