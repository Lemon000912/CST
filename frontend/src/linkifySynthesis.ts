import type { Paper } from "./types";

function normDoi(d: string) {
  return String(d ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
}

function normArxivId(raw: string) {
  return String(raw ?? "")
    .trim()
    .replace(/^arxiv:/i, "")
    .trim()
    .toLowerCase();
}

/** 从本次检索条目收集「允许生成外链」的 DOI / arXiv id，用于过滤模型幻觉编号 */
function allowedCitationTargets(papers?: Paper[]) {
  const dois = new Set<string>();
  const arxiv = new Set<string>();
  if (!papers?.length) return { dois, arxiv };

  for (const p of papers) {
    const d = normDoi(String(p.doi ?? ""));
    if (d && /^10\.\d{4,9}\//.test(d)) dois.add(d);

    let id = String(p.id ?? "").trim();
    if (id) {
      const ax = normArxivId(id);
      if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(ax)) {
        arxiv.add(ax);
        arxiv.add(ax.replace(/v\d+$/i, ""));
      }
    }
    for (const u of [p.absUrl, p.pdfUrl]) {
      const m = String(u ?? "").match(/arxiv\.org\/(?:abs|pdf)\/([^/?#]+)/i);
      if (m) {
        const mid = normArxivId(m[1].replace(/\.pdf$/i, ""));
        if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(mid)) {
          arxiv.add(mid);
          arxiv.add(mid.replace(/v\d+$/i, ""));
        }
      }
    }
  }
  return { dois, arxiv };
}

function arxivAllowed(idRaw: string, arxiv: Set<string>) {
  const id = normArxivId(idRaw);
  if (!/^\d{4}\.\d{4,5}(v\d+)?$/i.test(id)) return false;
  if (arxiv.has(id)) return true;
  return arxiv.has(id.replace(/v\d+$/i, ""));
}

/** 单条文献可外链的 URL（与图表溯源逻辑一致：先落地页，再 DOI，再 arXiv id） */
function paperLandingUrl(p: Paper | undefined): string | null {
  if (!p) return null;
  const u = String(p.absUrl ?? p.pdfUrl ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (u && /^https?:\/\//i.test(u)) return u;
  const d = normDoi(String(p.doi ?? ""));
  if (d && /^10\.\d{4,9}\//.test(d)) return `https://doi.org/${encodeURIComponent(d)}`;
  const rawId = String(p.id ?? "")
    .replace(/^arxiv:/i, "")
    .trim();
  const ax = normArxivId(rawId);
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(ax)) return `https://arxiv.org/abs/${ax}`;
  return null;
}

function linkifySynthesisCitationsPlain(s: string, papers?: Paper[]): string {
  let text = String(s ?? "");
  const { dois, arxiv } = allowedCitationTargets(papers);
  const strict = papers && papers.length > 0;

  text = text.replace(/\(\s*DOI:\s*(10\.\d{4,9}\/[^)\s]+)\s*\)/gi, (full, doi: string) => {
    const d = String(doi).trim();
    const n = normDoi(d);
    if (strict && !dois.has(n)) return full;
    const enc = encodeURIComponent(d);
    return `([DOI:${d}](https://doi.org/${enc}))`;
  });
  text = text.replace(/（\s*DOI:\s*(10\.\d{4,9}\/[^）\s]+)\s*）/gi, (full, doi: string) => {
    const d = String(doi).trim();
    const n = normDoi(d);
    if (strict && !dois.has(n)) return full;
    const enc = encodeURIComponent(d);
    return `（[DOI:${d}](https://doi.org/${enc})）`;
  });

  text = text.replace(/\(\s*arXiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\s*\)/gi, (full, idRaw: string) => {
    const id = String(idRaw).trim().replace(/^arxiv:/i, "");
    if (strict && !arxivAllowed(id, arxiv)) return full;
    return `([arXiv:${id}](https://arxiv.org/abs/${id}))`;
  });
  text = text.replace(/（\s*arXiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\s*）/gi, (full, idRaw: string) => {
    const id = String(idRaw).trim().replace(/^arxiv:/i, "");
    if (strict && !arxivAllowed(id, arxiv)) return full;
    return `（[arXiv:${id}](https://arxiv.org/abs/${id})）`;
  });

  // 模型常用 [arXiv:xxxx] 方括号形式（尚未带 URL）
  text = text.replace(/\[arXiv:\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)\]/gi, (_full, idRaw: string) => {
    const id = String(idRaw).trim().replace(/^arxiv:/i, "");
    if (strict && !arxivAllowed(id, arxiv)) return `arXiv:${id}`;
    return `[arXiv:${id}](https://arxiv.org/abs/${id})`;
  });
  text = text.replace(/\[DOI:\s*(10\.\d{4,9}\/[^\]]+)\]/gi, (_full, doi: string) => {
    const d = String(doi).trim();
    const n = normDoi(d);
    if (strict && !dois.has(n)) return `DOI:${d}`;
    return `[DOI:${d}](https://doi.org/${encodeURIComponent(d)})`;
  });

  if (papers?.length) {
    text = text.replace(/文献\s*\[\s*(\d+)\s*\]/g, (full, numStr: string) => {
      const n = Number(numStr);
      if (!Number.isFinite(n) || n < 1 || n > papers.length) return full;
      const url = paperLandingUrl(papers[n - 1]);
      if (!url) return full;
      return `[文献 [${n}]](${url})`;
    });

    const urlForIndex = (n: number): string | null => {
      if (!Number.isFinite(n) || n < 1 || n > papers.length) return null;
      return paperLandingUrl(papers[n - 1]);
    };

    text = text.replace(/【\s*(\d+)\s*】/g, (full, numStr: string) => {
      const n = Number(numStr);
      const url = urlForIndex(n);
      if (!url) return full;
      return `[【${n}】](${url})`;
    });

    text = text.replace(/\uff3b\s*(\d+)\s*\uff3d/g, (full, numStr: string) => {
      const n = Number(numStr);
      const url = urlForIndex(n);
      if (!url) return full;
      return `[［${n}］](${url})`;
    });

    text = text.replace(/\[\s*(\d+)\s*\](?!\s*[:(])/g, (full, numStr: string) => {
      const n = Number(numStr);
      const url = urlForIndex(n);
      if (!url) return full;
      return `[${n}](${url})`;
    });
  }

  return text;
}

/**
 * 将综述中的 (DOI:…)、(arXiv:…)、「文献 [n]」、**【n】** / [n] 编号引用转为 Markdown 链接（编号与本次检索列表顺序一致）。
 * 若提供 papers，则**仅对列表中真实出现的 DOI/arXiv** 生成链接，避免幻觉编号变成可点击假链。
 * **围栏代码块（``` … ```）内不处理**，以免破坏末尾 JSON 等。
 */
export function linkifySynthesisCitations(markdown: string, papers?: Paper[]): string {
  const s = String(markdown ?? "");
  const chunks: string[] = [];
  let i = 0;
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    chunks.push(linkifySynthesisCitationsPlain(s.slice(i, m.index), papers));
    chunks.push(m[0]);
    i = m.index + m[0].length;
  }
  chunks.push(linkifySynthesisCitationsPlain(s.slice(i), papers));
  return chunks.join("");
}
