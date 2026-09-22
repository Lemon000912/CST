export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return "";
  // Mermaid uses foreignObject for wrapped node labels. Keep those labels,
  // while still removing executable or embeddable elements from the SVG.
  root.querySelectorAll("script,iframe,object,embed").forEach((n) => n.remove());
  root.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((a) => {
      if (/^on/i.test(a.name) || /^(href|src|xlink:href)$/i.test(a.name) && /^(javascript|data:text\/html):/i.test(a.value.trim())) el.removeAttribute(a.name);
    });
  });
  return new XMLSerializer().serializeToString(root);
}
