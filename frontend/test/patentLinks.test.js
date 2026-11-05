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
const { remarkEuropeanPatentCitations, europeanPublicationLinks } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const render = markdown => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkEuropeanPatentCitations] }, markdown));
const pdf = n => europeanPublicationLinks(n).pdf;

test("保留正文和数字引用，仅把 EP 圆圈的地址改为官方 PDF", () => {
  const output=render('- EP0816797B1《电缆腐蚀程度测量装置》 [2](https://patents.google.com/patent/EP0816797B1/en)');
  assert.match(output,/EP0816797B1《电缆腐蚀程度测量装置》/);
  assert.ok(output.includes(`href="${pdf('EP0816797B1')}"`));
  assert.match(output,/>2<\/a>/);
  assert.equal((output.match(/<a /g)||[]).length,1);
  assert.doesNotMatch(output,/（检索）|专利原文与官方入口|按公开号打开/);
});

test("每条专利对应自己的 A2、B1 版本，来源链接冲突时以明确的本段 EP 号为准", () => {
  const output=render('- EP0816797A2 [1](https://example.com/source)\n- EP0816797B1 [1](https://patents.google.com/patent/CN105896119A)');
  assert.ok(output.includes(pdf('EP0816797A2')));
  assert.ok(output.includes(pdf('EP0816797B1')));
});

test("CN、JP、US 圆圈及普通网页引用保留原地址", () => {
  for(const number of ['CN122201879A','JP4566407B2','US5347212A']) {
    const output=render(`${number} [2](https://example.com/source)`);
    assert.match(output,/href="https:\/\/example.com\/source"/);
    assert.doesNotMatch(output,/data.epo.org/);
  }
  assert.match(render('普通引用 [3](https://example.com/web)'),/href="https:\/\/example.com\/web"/);
});

test("未出现正文编号时可从原专利 URL 识别 EP 号", () => {
  assert.ok(render('相关文献 [1](https://patents.google.com/patent/EP0816797A3/en)').includes(pdf('EP0816797A3')));
  assert.ok(render('文献 [1](https://data.epo.org/publication-server/pdf-document?cc=EP&pn=0816797&ki=B1)').includes(pdf('EP0816797B1')));
});

test("不改已有非数字链接、裸编号或代码", () => {
  const output=render('EP0816797B1 [原文](https://example.com/doc) `EP0816797A3 [1](https://example.com/a)`\n\n```md\nEP0816797A3 [1](https://example.com/a)\n```');
  assert.equal((output.match(/<a /g)||[]).length,1);
  assert.match(output,/href="https:\/\/example.com\/doc"/);
  assert.doesNotMatch(output,/data.epo.org/);
});

test("多专利段落仅重定向能明确匹配编号的来源，不猜测版本", () => {
  assert.doesNotMatch(render('EP0816797A2 / EP0816797B1 [1](https://example.com/source)'),/data.epo.org/);
  assert.ok(render('EP0816797A2 / EP0816797B1 [1](https://patents.google.com/patent/EP0816797B1)').includes(pdf('EP0816797B1')));
  assert.doesNotMatch(render('EP0816797A2 / EP0816797B1 [1](https://patents.google.com/patent/EP1502502A1)'),/data.epo.org/);
});

test("表格中的圆圈也能跳转，非欧洲编号不会生成 EPO 链接", () => {
  const output=render('| 专利 | 原文 |\n| --- | --- |\n| EP0816797B1 | [1](https://patents.google.com/patent/EP0816797B1) |');
  assert.ok(output.includes(pdf('EP0816797B1')));
  assert.equal(europeanPublicationLinks('CN122201879A'),null);
  assert.equal(europeanPublicationLinks('EP0816797C0'),null);
});

test("拒绝从伪造域名、带凭据的 URL 和申请号猜测欧洲文献", () => {
  for(const url of ['https://patents.google.com.evil.example/patent/EP0816797B1','https://user:pass@patents.google.com/patent/EP0816797B1','https://patents.google.com/patent/EP202600123456A']) {
    assert.doesNotMatch(render(`普通引用 [1](${url})`),/data.epo.org/);
  }
});
