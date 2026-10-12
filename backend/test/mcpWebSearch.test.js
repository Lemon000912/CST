import test from "node:test";
import assert from "node:assert/strict";

import { fetchDuckDuckGoSearch, fetchFinanceWebPapers, fetchGooglePatentsSearch } from "../mcpWebSearch.js";

test("finance site search limits results to the requested public domain", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSources = process.env.WEB_SOURCES;
  const originalFastPath = process.env.WEB_BING_FAST_PATH;
  const originalFallback = process.env.WEB_CN_BING_FALLBACK;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSources === undefined) delete process.env.WEB_SOURCES;
    else process.env.WEB_SOURCES = originalSources;
    if (originalFastPath === undefined) delete process.env.WEB_BING_FAST_PATH;
    else process.env.WEB_BING_FAST_PATH = originalFastPath;
    if (originalFallback === undefined) delete process.env.WEB_CN_BING_FALLBACK;
    else process.env.WEB_CN_BING_FALLBACK = originalFallback;
  });

  process.env.WEB_SOURCES = "ddg";
  process.env.WEB_BING_FAST_PATH = "0";
  process.env.WEB_CN_BING_FALLBACK = "0";
  const requestedQueries = [];
  globalThis.fetch = async (url) => {
    requestedQueries.push(new URL(String(url)).searchParams.get("q"));
    return new Response([
      '<div class="result"><a rel="nofollow" class="result-link" href="https://quote.eastmoney.com/company">东方财富公司页</a><td class="result-snippet">公司公告与财务信息</td></div>',
      '<div class="result"><a rel="nofollow" class="result-link" href="https://www.wind.com.cn/company">万得公司页</a><td class="result-snippet">行业研究与数据</td></div>',
    ].join(""), { status: 200, headers: { "content-type": "text/html" } });
  };

  const eastmoney = await fetchFinanceWebPapers("平安银行 财报", 5, "eastmoney");
  const wind = await fetchFinanceWebPapers("平安银行 财报", 5, "wind");
  assert.ok(requestedQueries.every((query) => query.includes("site:")));
  assert.equal(eastmoney.papers.length, 1);
  assert.equal(eastmoney.papers[0].source, "finance_web");
  assert.equal(eastmoney.papers[0].venue, "东方财富网");
  assert.match(eastmoney.papers[0].absUrl, /eastmoney\.com/);
  assert.equal(wind.papers.length, 1);
  assert.equal(wind.papers[0].venue, "万得");
  assert.match(wind.papers[0].absUrl, /wind\.com\.cn/);
});

test("DuckDuckGo results are converted without an undefined result cap", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    '<html><div class="result"><a rel="nofollow" class="result-link" href="https://example.com/patent">Example patent</a><td class="result-snippet">A patent result</td></div></html>',
    { status: 200, headers: { "content-type": "text/html" } },
  );
  try {
    const result = await fetchDuckDuckGoSearch("example patent", 5, { skipBing: true, forPatent: true });
    assert.equal(result.note, "ddg_ok");
    assert.equal(result.papers.length, 1);
    assert.equal(result.papers[0].source, "ddg_patent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google Patents results provide patent rows when general web search is noisy", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: {
      cluster: [{
        result: [{
          patent: {
            publication_number: "CN123456A",
            title: "一种石墨烯锂离子电池导电剂",
            snippet: "用于锂离子电池电极的导电添加剂。",
            publication_date: "2024-01-02",
          },
        }],
      }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        results: {
          cluster: [{
            result: [{
              patent: {
                publication_number: "CN123456A",
                title: "一种石墨烯锂离子电池导电剂",
                snippet: "用于锂离子电池电极的导电添加剂。",
                publication_date: "2024-01-02",
              },
            }],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await fetchGooglePatentsSearch("锂离子电池 石墨烯 导电剂", 5, { country: "CN" });
    assert.equal(result.note, "google-patents-cn_ok");
    const encodedParams = new URL(requestedUrl).searchParams.get("url");
    assert.match(encodedParams, /country=CN/);
    assert.equal(result.papers.length, 1);
    assert.equal(result.papers[0].source, "ddg_patent");
    assert.equal(result.papers[0].patentNumber, "CN123456A");
    assert.match(result.papers[0].absUrl, /patents\.google\.com\/patent\/CN123456A/);
    assert.equal(result.papers[0].patentSource, "google_patents_cn");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
