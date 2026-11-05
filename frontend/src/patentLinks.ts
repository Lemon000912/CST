import type { Root, RootContent, Link, Text } from "mdast";
import type { Paper } from "./types";

const PUBLICATION = /\b(?:CN|EP|US|WO|JP|KR|DE|FR|GB|TW|IN)[ -]?\d{6,14}[ -]?[ABCUYTS]\d{0,2}\b/gi;
const normalize = (value: string) => value.replace(/[ -]/g, "").toUpperCase();

function safeUrl(raw: string | undefined): string | null {
  try {
    const url = new URL(String(raw ?? ""));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function isPatentUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return /(^|\.)(patents\.google\.com|epo\.org|espacenet\.com|lens\.org|freepatentsonline\.com|patentscope\.wipo\.int|cnipa\.gov\.cn|uspto\.gov|j-platpat\.inpit\.go\.jp)$/i.test(host);
  } catch { return false; }
}

function targets(papers: Paper[]) {
  const result = new Map<string, { page: string | null; pdf: string | null }>();
  for (const paper of papers) {
    // Only the record's own identifier or publication URL may establish a
    // document target. Numbers merely mentioned in a summary are search hints.
    const ids: string[] = String(paper.patentNumber ?? "").match(PUBLICATION) ?? [];
    for (const raw of [paper.absUrl, paper.pdfUrl]) {
      const match = String(raw ?? "").match(/patents\.google\.com\/patent\/([^/?#]+)/i);
      if (match) ids.push(...(match[1].match(PUBLICATION) ?? []));
    }
    const page = safeUrl(paper.absUrl);
    const candidate = safeUrl(paper.pdfUrl);
    const pdf = candidate && /(?:\.pdf(?:$|[/?])|\/pdf(?:$|[/-])|\/pdf-document(?:$|[/?]))/i.test(new URL(candidate).pathname) ? candidate : null;
    for (const id of ids) {
      const key = normalize(id);
      const previous = result.get(key);
      result.set(key, { page: previous?.page ?? page, pdf: previous?.pdf ?? pdf });
    }
  }
  return result;
}

const text = (value: string): Text => ({ type: "text", value });
const link = (label: string, url: string, title: string): Link => ({ type: "link", url, title, children: [text(label)] });

/** Link only Markdown text nodes: existing URLs, links and code stay intact. */
export function remarkPatentLinks({ papers = [] }: { papers?: Paper[] } = {}) {
  const known = targets(papers);
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (["link", "linkReference", "code", "inlineCode", "html", "image", "imageReference"].includes(node.type) || !("children" in node)) return;
      const children: RootContent[] = [];
      for (const child of node.children) {
        if (child.type !== "text") { visit(child); children.push(child); continue; }
        let cursor = 0;
        for (const match of child.value.matchAll(PUBLICATION)) {
          const index = match.index!;
          children.push(text(child.value.slice(cursor, index)));
          const number = normalize(match[0]);
          const target = known.get(number);
          const url = target?.page ?? target?.pdf;
          children.push(url
            ? link(match[0], url, "专利来源页")
            : link(`${match[0]}（检索）`, `https://patents.google.com/?q=${encodeURIComponent(number)}`, "按公开号检索"));
          if (target?.pdf && target.pdf !== url) {
            children.push(text(" · "), link("原文 PDF", target.pdf, "专利原文 PDF"));
          }
          cursor = index + match[0].length;
        }
        children.push(text(child.value.slice(cursor)));
      }
      // All inserted nodes are phrasing content; the original block hierarchy
      // is unchanged, including headings, tables and list items.
      node.children = children as typeof node.children;
    };
    visit(tree);
  };
}
