import type { Root, RootContent, Link } from "mdast";

const PUBLICATION = /\b(?:CN|EP|US|WO|JP|KR|DE|FR|GB|TW|IN)[ -]?\d{6,14}[ -]?[ABCUYTS]\d{0,2}\b/gi;
const normalize = (value: string) => value.replace(/[ -]/g, "").toUpperCase();

export function europeanPublicationLinks(raw: string) {
  const match = normalize(raw).match(/^EP(\d{6,7})(A[12389]|B[12389])$/);
  if (!match) return null;
  const number = match[1].padStart(7, "0");
  const root = `https://data.epo.org/publication-server/rest/v1.2/patents/EP${number}NW${match[2]}`;
  return { pdf: `${root}/document.pdf`, html: `${root}/document.html` };
}

function publicationFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === "patents.google.com") return url.pathname.match(/^\/patent\/(EP\d{6,7}[AB]\d)(?:\/|$)/i)?.[1] ?? null;
    if (host === "data.epo.org") {
      const rest = url.pathname.match(/\/patents\/EP(\d{7})NW([AB]\d)(?:\/|$)/i);
      if (rest) return `EP${rest[1]}${rest[2]}`;
      if (url.searchParams.get("cc")?.toUpperCase() === "EP") return `EP${url.searchParams.get("pn") ?? ""}${url.searchParams.get("ki") ?? ""}`;
    }
    if (host === "espacenet.com" || host.endsWith(".espacenet.com")) {
      return [...(url.searchParams.get("q") ?? "").matchAll(/\bEP\d{6,7}[AB]\d\b/gi)].map(m => m[0])[0] ?? null;
    }
  } catch { /* Keep the original citation if its source cannot be identified. */ }
  return null;
}

function visibleText(node: Root | RootContent): string {
  if (["code", "inlineCode", "html", "image", "imageReference"].includes(node.type)) return "";
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map(visibleText).join("") : "";
}

/** Preserve the original answer and citation circles; change only EP targets. */
export function remarkEuropeanPatentCitations() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent, context: string[] = []) => {
      if (["code", "inlineCode", "html"].includes(node.type)) return;
      if (node.type === "paragraph" || node.type === "tableCell") {
        context = [...new Set((visibleText(node).match(PUBLICATION) ?? []).map(normalize))];
      }
      if (node.type === "link") {
        const citation = node as Link;
        if (!/^\d{1,3}$/.test(visibleText(citation).trim())) return;
        // Resolve a single visible publication locally. Do not choose an
        // arbitrary version in paragraphs discussing multiple documents.
        const contextual = context.length === 1 ? context[0] : null;
        const source = publicationFromUrl(citation.url);
        const number = contextual && europeanPublicationLinks(contextual) ? contextual : source;
        if (!number || (context.length > 1 && !context.includes(normalize(number)))) return;
        const target = europeanPublicationLinks(number);
        if (target) {
          citation.url = target.pdf;
          citation.title = `European Publication Server · ${number} · PDF`;
        }
        return;
      }
      if ("children" in node) for (const child of node.children) visit(child, context);
    };
    visit(tree);
  };
}
