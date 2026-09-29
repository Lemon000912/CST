import test from "node:test";
import assert from "node:assert/strict";

import { fetchDuckDuckGoSearch } from "../mcpWebSearch.js";

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
