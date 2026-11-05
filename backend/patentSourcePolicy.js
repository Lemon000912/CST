// 专利渠道暂时只开放 European Publication Server；旧缓存和普通网页混入的专利页也要受此限制。
export const PATENT_SOURCE_POLICY = "eps-only-v1";
export const EPS_SOURCE = { id: "epo_publication_server", label: "European Publication Server", domain: "data.epo.org" };

export function epsDocument(number, format = "pdf") {
  const match = String(number ?? "").toUpperCase().replace(/[\s-]/g, "").match(/^EP(\d{6,7})(?:NW)?([AB][12389])$/);
  if (!match) return null;
  const patentNumber = `EP${match[1].padStart(7, "0")}${match[2]}`;
  return { patentNumber, url: `https://data.epo.org/publication-server/rest/v1.2/patents/EP${match[1].padStart(7, "0")}NW${match[2]}/document.${format}` };
}

export function isEpsPatentPaper(p) {
  const doc = epsDocument(p?.patentNumber);
  return Boolean(doc && p?.patentSource === EPS_SOURCE.id && p?.epsVerified === true && p?.absUrl === doc.url && p?.pdfUrl === doc.url);
}

export function isAllowedPatentSource(p) {
  if (isEpsPatentPaper(p)) return true;
  if (/patent/i.test(String(p?.source ?? "")) || p?.patentNumber || p?.patentSource) return false;
  for (const raw of [p?.absUrl, p?.pdfUrl]) {
    try {
      const u = new URL(raw);
      if (/(^|\.)(?:patents\.google\.[a-z.]+|espacenet\.com|cnipa\.gov\.cn|uspto\.gov|j-platpat\.inpit\.go\.jp|lens\.org|freepatentsonline\.com|patentscope\.wipo\.int|epo\.org)$/.test(u.hostname) && /patent|publication|espacenet|cnipa|j-platpat|lens\./i.test(u.href)) return false;
      if (/\/patents?\//i.test(u.pathname)) return false;
    } catch { /* 普通论文未必有 URL。 */ }
  }
  return !/\b(?:CN|US|JP|WO|EP|KR|DE|GB|FR)\s*\d{6,}(?:[A-C]\d?)?\b/i.test(String(p?.title ?? ""));
}

export function filterPatentSources(papers) {
  return (Array.isArray(papers) ? papers : []).filter(isAllowedPatentSource);
}

export function epsPatentInstructions(papers) {
  const allowed = Array.isArray(papers) ? "\n本轮已核验专利白名单（合并/仲裁也仅允许这些编号及链接）：" + (papers.filter(isEpsPatentPaper).map(p => `${p.patentNumber} ${p.absUrl}`).join("；") || "无，不得列具体专利") : "";
  return "\n\n【专利来源限制（优先执行）】专利仅允许 European Publication Server 的 EP 原文。只能列出摘录中明确标注「类型:专利」且 URL 为 https://data.epo.org/publication-server/rest/v1.2/patents/ 的条目，保留该条目的 EP 公开号及原文 URL，并使用原有 [n] 引用。禁止使用 Google Patents、Espacenet、OpenAlex、CN/US/JP/WO 等其他专利渠道；禁止根据普通网页、对话历史或模型记忆补写专利、猜测 EP 同族编号、把不同编号绑定同一个引用。无符合条件的专利摘录时，不列具体专利，必要时说明「本次未检索到可核验的 EPS 专利原文」。普通网页仍可支撑非专利内容。合并或仲裁时也须删除不符合此限制的专利条目。" + allowed;
}
