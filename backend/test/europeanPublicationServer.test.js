import { scoreWebPaperForAnswer, buildWebAnswerTokens } from "../webRelevance.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fetchEpsPatentPapers, parseEpsXml, buildEpsDiscoveryQueries, extractEpNumbers } from "../europeanPublicationServer.js";
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
      assert.match(q, /^site:data\.epo\.org\/publication-server /);
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

test("中文问题复用英文检索词并保留腐蚀目标，最长128字符", () => {
  const queries = buildEpsDiscoveryQueries("地下电线腐蚀怎么非接触测量", "underground electric cable corrosion non-contact measurement");
  assert.ok(queries.length >= 2);
  for (const q of queries) { assert.match(q, /corrosion/); assert.match(q, /cable/); assert.ok(q.length <= 128); assert.doesNotMatch(q, /[\u4e00-\u9fff]/); }
  assert.ok(queries.some(q => !q.includes("underground")));
  assert.deepEqual(extractEpNumbers("EP 0 816 797 B1"), ["EP0816797B1"]);
});

test("关键词无结果时直接使用EPS分类索引，拒绝无PDF和非EP条目", async () => {
  const calls = [];
  const result = await fetchEpsPatentPapers("cable corrosion", 8, {
    plan: async () => ({ queries: [], ipcCodes: ["G01N17/00"] }),
    fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url.includes("/publications?")) {
        assert.equal(opts.method, "POST"); assert.equal(opts.redirect, "error");
        assert.equal(JSON.parse(opts.body).ipcSymbol, "G01N17/00");
        return Response.json({ content: [
          { countryCode: "EP", publishedByEpo: true, publicationNumber: "0816797", publicationKind: "B1", pdfFile: "official.pdf" },
          { countryCode: "EP", publishedByEpo: true, publicationNumber: "1234567", publicationKind: "A1", pdfFile: "" },
          { countryCode: "CN", publishedByEpo: false, publicationNumber: "105896119", publicationKind: "A", pdfFile: "other.pdf" },
        ] });
      }
      return new Response(oldXml);
    },
  });
  assert.equal(result.papers.length, 1); assert.equal(result.papers[0].absUrl, docUrl);
  assert.equal(calls.length, 2); assert.ok(calls.every(url => url.startsWith("https://data.epo.org/publication-server/")));
});

test("现代EPS页面路径也能提取编号；忽略摘要里另外列的参考专利", async () => {
  const urls = [];
  const result = await fetchEpsPatentPapers("cable corrosion", 2, {
    discover: async () => ({ papers: [{ absUrl: "https://data.epo.org/publication-server/document/pdf/0816797/B1/2002-09-18", summary: "EP1234567A1" }] }),
    fetchImpl: async url => { urls.push(url); return new Response(oldXml); },
  });
  assert.equal(result.papers.length, 1); assert.equal(urls.length, 1); assert.match(urls[0], /EP0816797NWB1/);
});

test("腐蚀问题不能用仅电压测量的专利凑数", async () => {
  const result = await fetchEpsPatentPapers("地下电线腐蚀非接触测量", 2, {
    effectiveQuery: "underground cable corrosion non contact measurement",
    discover: async () => ({ papers: [{ absUrl: docUrl }] }),
    fetchImpl: async () => new Response(oldXml.replace("Apparatus for measuring corrosion &amp; cable", "Non contact voltage measurement").replace("Magnetic inspection of steel cable.", "Three phase voltage measurement.")),
  });
  assert.equal(result.papers.length, 0);
});


test("检索相关性在最终摘录选择中保留，腐蚀检测不能被泛化电压词压下去", () => {
  const raw = "地下电线腐蚀如何非接触测量";
  const effective = "underground cable corrosion non contact measurement detection";
  const tokens = buildWebAnswerTokens(raw + " " + effective);
  const relevant = { ...parseEpsXml(oldXml, "EP0816797B1"), epsRelevanceScore: 180 };
  const generic = { source: "deepseek_web", title: "underground cable non contact voltage measurement detection", summary: "三相电线非接触电压检测", absUrl: "https://example.com/voltage" };
  assert.ok(scoreWebPaperForAnswer(relevant, tokens, raw, effective) > scoreWebPaperForAnswer(generic, tokens, raw, effective));
});

test("网页定位超时不会丢弃已完成的EPS分类检索", async () => {
  const result = await fetchEpsPatentPapers("cable corrosion", 2, {
    discoveryTimeoutMs: 20,
    plan: async () => ({ queries: ["site:data.epo.org cable corrosion"], ipcCodes: ["G01N17/00"] }),
    discover: () => new Promise(() => {}),
    fetchImpl: async url => url.includes("/publications?") ? Response.json({ content: [{ countryCode: "EP", publishedByEpo: true, publicationNumber: "0816797", publicationKind: "B1", pdfFile: "official.pdf" }] }) : new Response(oldXml),
  });
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].patentNumber, "EP0816797B1");
});
