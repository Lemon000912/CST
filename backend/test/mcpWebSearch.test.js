import test from "node:test";
import assert from "node:assert/strict";

import { fetchDuckDuckGoSearch, fetchGooglePatentsSearch } from "../mcpWebSearch.js";

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
