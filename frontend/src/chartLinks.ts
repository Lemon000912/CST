import type { Paper } from "./types";

/** 将图表溯源标签解析为可打开的 URL（新标签页） */
export function resolveLiteratureUrl(tag: string, papers: Paper[]): string | null {
  const t = String(tag ?? "")
    .trim()
    .replace(/^—+$/, "");
  if (!t) return null;
  const low = t.toLowerCase();
  if (low.startsWith("arxiv:")) {
    const id = t.slice(6).trim();
    if (!id) return null;
    return `https://arxiv.org/abs/${encodeURIComponent(id)}`;
  }
  if (/^10\.\d/i.test(t)) {
    return `https://doi.org/${encodeURIComponent(t)}`;
  }
  if (low.startsWith("url:")) {
    const url = t.slice(4).trim();
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    return `https://${url}`;
  }
  if (low.startsWith("scopus_url:")) {
    const url = t.slice(11).trim();
    if (url.startsWith("http")) return url;
    return `https://${url}`;
  }
  if (low.startsWith("europepmc_url:")) {
    const url = t.slice(14).trim();
    if (url.startsWith("http")) return url;
    return `https://${url}`;
  }
  if (low.startsWith("openalex_url:")) {
    const url = t.slice(13).trim();
    if (url.startsWith("http")) return url;
    return `https://${url}`;
  }
  if (low.startsWith("sem_scholar_url:")) {
    const url = t.slice(16).trim();
    if (url.startsWith("http")) return url;
    return `https://${url}`;
  }
  if (t.startsWith("paper_id:")) {
    const pid = t.slice(9).trim();
    const p = papers.find((x) => String(x.paper_id ?? "") === pid);
    if (p?.absUrl) return p.absUrl;
    if (p?.pdfUrl) return p.pdfUrl;
    return null;
  }
  if (t.startsWith("id:")) {
    const id = t.slice(3).trim();
    const p = papers.find((x) => String(x.id ?? "") === id);
    if (p?.absUrl) return p.absUrl;
    if (p?.pdfUrl) return p.pdfUrl;
    return null;
  }
  if (low.startsWith("patent:") || low.startsWith("openalex:") ||
      low.startsWith("scopus:") || low.startsWith("europepmc:") ||
      low.startsWith("sem_scholar:") || low.startsWith("web_page:")) {
    const p = papers.find((x) => {
      const pid = String(x.paper_id ?? "").trim();
      const sid = String(x.id ?? "").trim();
      const tagId = t.split(":", 2)[1]?.trim() || "";
      return pid === tagId || sid === tagId;
    });
    if (p?.absUrl) return p.absUrl;
    if (p?.pdfUrl) return p.pdfUrl;
    return null;
  }
  const byDoi = papers.find((x) => String(x.doi ?? "").trim() === t);
  if (byDoi?.absUrl) return byDoi.absUrl;
  if (byDoi?.pdfUrl) return byDoi.pdfUrl;
  return null;
}
