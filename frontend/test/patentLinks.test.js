import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { renderToStaticMarkup } from "react-dom/server";

const source = fs.readFileSync(new URL("../src/patentLinks.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { remarkPatentLinks, isPatentUrl } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const render = (markdown, papers = []) => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, [remarkPatentLinks, { papers }]] }, markdown));

test("有题录来源的专利显示来源页及实际提供的 PDF", () => {
  const result = render("- CN12201879A 《电缆制备方法》 [1](https://example.com/article)", [{ patentNumber: "CN12201879A", absUrl: "https://patents.google.com/patent/CN12201879A/zh", pdfUrl: "https://example.com/patent.pdf" }]);
  assert.match(result, /href="https:\/\/patents.google.com\/patent\/CN12201879A\/zh" title="专利来源页">CN12201879A<\/a>/);
  assert.match(result, /href="https:\/\/example.com\/patent.pdf" title="专利原文 PDF">原文 PDF<\/a>/);
  assert.match(result, /href="https:\/\/example.com\/article">1<\/a>/);
});

test("未核实的公开号显示编号检索，不编造专利直达页或 PDF", () => {
  const result = render("EP0816797A3 / EP0816797B1");
  assert.match(result, /q=EP0816797A3/);
  assert.match(result, /q=EP0816797B1/);
  assert.equal((result.match(/（检索）/g) || []).length, 2);
  assert.doesNotMatch(result, /pdf-document|原文 PDF|\/patent\//);
});

test("已有链接、代码和原始 URL 不生成嵌套链接", () => {
  const result = render('[CN12201879A](https://example.com/patent) `CN12201879A`\n\n```text\nEP0816797A3\n```\n\nhttps://patents.google.com/patent/EP0816797B1/en');
  assert.equal((result.match(/<a /g) || []).length, 2);
  assert.doesNotMatch(result, /（检索）/);
  assert.match(result, /<code>CN12201879A<\/code>/);
});

test("支持表格、粗体编号和编号中的空格，保持申请号原文", () => {
  const result = render("| 专利 | 说明 |\n| --- | --- |\n| **EP 0816797 A3** | 样例 |\n\n申请号 CN202610579523.9");
  assert.match(result, /<strong><a href="https:\/\/patents.google.com\/\?q=EP0816797A3/);
  assert.match(result, /CN202610579523.9/);
  assert.equal((result.match(/<a /g) || []).length, 1);
});

test("摘要提到多个编号不会把它们全部指向同一个网页或 PDF", () => {
  const result = render("CN12201879A 和 CN122105198A", [{ summary: "CN12201879A 和 CN122105198A", absUrl: "https://example.com/article", pdfUrl: "https://example.com/article.pdf" }]);
  assert.equal((result.match(/（检索）/g) || []).length, 2);
  assert.doesNotMatch(result, /example.com/);
});

test("拒绝危险 URL、凭据 URL 和伪造专利域名", () => {
  const result = render("CN12201879A", [{ patentNumber: "CN12201879A", absUrl: "javascript:alert(1)", pdfUrl: "https://user:password@example.com/patent.pdf" }]);
  assert.match(result, /（检索）/);
  assert.doesNotMatch(result, /javascript:|password/);
  assert.equal(isPatentUrl("https://data.epo.org/publication-server/pdf-document?cc=EP"), true);
  assert.equal(isPatentUrl("https://epo.org.evil.example/patent"), false);
});

test("PDF 字段实际是专利落地页时不标注成 PDF", () => {
  const result = render("US12345678B2", [{ patentNumber: "US12345678B2", absUrl: "https://patents.google.com/patent/US12345678B2/en", pdfUrl: "https://patents.google.com/patent/US12345678B2/en" }]);
  assert.doesNotMatch(result, /原文 PDF/);
});
