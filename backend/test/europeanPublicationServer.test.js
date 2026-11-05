import test from "node:test";
import assert from "node:assert/strict";
import { fetchEpsPatentPapers, parseEpsXml } from "../europeanPublicationServer.js";
import { filterPatentSources, epsPatentInstructions, isEpsPatentPaper } from "../patentSourcePolicy.js";
const oldXml = `<ep-patent-document country="EP" doc-number="0816797" kind="B1" date-publ="20020918"><B540><B541>en</B541><B542>Apparatus for measuring corrosion &amp; cable</B542></B540><description><p>Magnetic inspection of steel cable.</p></description></ep-patent-document>`;
const docUrl = "https://data.epo.org/publication-server/rest/v1.2/patents/EP0816797NWB1/document.pdf";
test("直接 EP 公开号只访问 EPS，题录与摘要取自官方 XML", async () => {
  const urls = [];
  const result = await fetchEpsPatentPapers("EP 0816797 B1", 10, {
    discover: () => { throw new Error("不能外呼其他专利渠道"); },
    fetchImpl: async (url, opts) => { urls.push(url); assert.equal(opts.redirect, "error"); return new Response(oldXml); },
  });
  assert.equal(result.papers.length, 1);
  assert.deepEqual(urls, [docUrl.replace("pdf", "xml")]);
  const p = result.papers[0];
  assert.equal(p.absUrl, docUrl); assert.equal(p.pdfUrl, docUrl);
  assert.equal(p.title, "Apparatus for measuring corrosion & cable");
  assert.equal(p.summary, "Magnetic inspection of steel cable.");
  assert.equal(p.published, "2002-09-18"); assert.ok(isEpsPatentPaper(p));
});
test("关键词仅定位 EPS，忽略 Google 和伪造域名，展示前核验原文", async () => {
  const requests = [];
  const result = await fetchEpsPatentPapers("cable corrosion", 10, {
    discover: async q => {
      assert.match(q, /site:data\.epo\.org\/publication-server$/);
      return { papers: [
        { absUrl: "https://patents.google.com/patent/EP1234567A1", title: "其他渠道" },
        { absUrl: "https://data.epo.org.evil.test/publication-server/EP1234567A1" },
        { absUrl: docUrl, title: "搜索摘要错误标题" },
      ] };
    },
    fetchImpl: async url => { requests.push(url); return new Response(oldXml); },
  });
  assert.equal(requests.length, 1); assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].title, "Apparatus for measuring corrosion & cable");
});
test("不存在、编号不一致或 HTML 空壳均不展示且不回退", async () => {
  for (const response of [new Response("not found", { status: 404 }), new Response(oldXml.replace('kind="B1"', 'kind="A1"')), new Response("<html>EPS app</html>")]) {
    const result = await fetchEpsPatentPapers("EP0816797B1", 2, { fetchImpl: async () => response });
    assert.deepEqual(result.papers, []); assert.equal(result.note, "eps_no_verified_documents");
  }
});
test("支持现代 EPS XML 的英文标题和摘要", () => {
  const xml = oldXml.replace(/<B540>[\s\S]*?<\/B540>/, '<invention-title lang="de">DE Titel</invention-title><invention-title lang="en">English title</invention-title>').replace(/<description>[\s\S]*?<\/description>/, '<abstract><p>Official abstract.</p></abstract>');
  assert.equal(parseEpsXml(xml, "EP0816797B1").title, "English title");
  assert.equal(parseEpsXml(xml, "EP0816797B1").summary, "Official abstract.");
});
test("过滤普通网页混入的旧专利，保留普通网页和论文", () => {
  const official = parseEpsXml(oldXml, "EP0816797B1");
  const web = { source: "deepseek_web", title: "电缆检测技术进展", absUrl: "https://example.com/news" };
  const paper = { source: "openalex", title: "Cable testing", doi: "10.test/cable" };
  const result = filterPatentSources([
    official, web, paper,
    { source: "deepseek_web", absUrl: "https://patents.google.com/patent/CN105896119A/#legalEvents#3" },
    { source: "mcp_web", absUrl: "https://worldwide.espacenet.com/patent/search?q=EP0816797B1" },
    { source: "openalex_patent", patentNumber: "EP0816797B1", absUrl: docUrl },
    { ...official, epsVerified: false },
    { source: "ddg_web", title: "CN105896119A 电缆专利", absUrl: "https://example.com/info" },
  ]);
  assert.deepEqual(result, [official, web, paper]);
  assert.match(epsPatentInstructions(result), /EP0816797B1 https:\/\/data\.epo\.org/);
  assert.match(epsPatentInstructions([web]), /无，不得列具体专利/);
});
test("取消搜索可中断不响应 signal 的定位器", async () => {
  const c = new AbortController();
  const task = fetchEpsPatentPapers("cable corrosion", 2, { signal: c.signal, discover: () => new Promise(() => {}) });
  c.abort(new Error("用户取消"));
  await assert.rejects(task, /用户取消/);
});
