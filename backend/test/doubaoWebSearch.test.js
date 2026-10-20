import test from "node:test";
import assert from "node:assert/strict";

import {
  extractDoubaoCitations,
  fetchDoubaoWebPapers,
  getDoubaoWebSearchConfig,
} from "../doubaoWebSearch.js";
import { getWebSearchProviderConfig } from "../mcpWebSearch.js";

test("Doubao citations accept nested source URLs", () => {
  const rows = extractDoubaoCitations({
    sources: [
      { title: "国家统计局", url: "https://www.stats.gov.cn/report", snippet: "工业数据" },
      { link: "https://example.com/a", name: "Example" },
    ],
  }, "answer");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "国家统计局");
});

test("Doubao adapter is disabled without a server-side key", async () => {
  const old = process.env.REDFOX_API_KEY;
  delete process.env.REDFOX_API_KEY;
  try {
    assert.equal(getDoubaoWebSearchConfig(), null);
    const result = await fetchDoubaoWebPapers("工业数据", 5);
    assert.equal(result.note, "not-configured");
    assert.equal(result.papers.length, 0);
  } finally {
    if (old === undefined) delete process.env.REDFOX_API_KEY;
    else process.env.REDFOX_API_KEY = old;
  }
});

test("Doubao adapter submits and polls a completed task", async (t) => {
  const old = {
    key: process.env.REDFOX_API_KEY,
    base: process.env.REDFOX_DOUBAOSEARCH_BASE,
    poll: process.env.REDFOX_DOUBAOSEARCH_POLL_MS,
    attempts: process.env.REDFOX_DOUBAOSEARCH_MAX_ATTEMPTS,
  };
  const oldFetch = globalThis.fetch;
  process.env.REDFOX_API_KEY = "test-key";
  process.env.REDFOX_DOUBAOSEARCH_BASE = "https://redfox.test/doubao";
  process.env.REDFOX_DOUBAOSEARCH_POLL_MS = "500";
  process.env.REDFOX_DOUBAOSEARCH_MAX_ATTEMPTS = "2";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (calls.length === 1) return new Response(JSON.stringify({ data: { taskId: "task-1" } }), { status: 200 });
    return new Response(JSON.stringify({ data: { status: "completed", result: {
      content: "答案",
      sources: [{ title: "来源", url: "https://example.com/report", snippet: "证据" }],
    } } }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (old.key === undefined) delete process.env.REDFOX_API_KEY; else process.env.REDFOX_API_KEY = old.key;
    if (old.base === undefined) delete process.env.REDFOX_DOUBAOSEARCH_BASE; else process.env.REDFOX_DOUBAOSEARCH_BASE = old.base;
    if (old.poll === undefined) delete process.env.REDFOX_DOUBAOSEARCH_POLL_MS; else process.env.REDFOX_DOUBAOSEARCH_POLL_MS = old.poll;
    if (old.attempts === undefined) delete process.env.REDFOX_DOUBAOSEARCH_MAX_ATTEMPTS; else process.env.REDFOX_DOUBAOSEARCH_MAX_ATTEMPTS = old.attempts;
  });
  const result = await fetchDoubaoWebPapers("工业数据", 5);
  assert.equal(result.note, "ok:1");
  assert.equal(result.papers[0].source, "doubao_web");
  assert.equal(calls[0].body.inquiry_text, "工业数据");
  assert.equal(calls[0].headers["X-API-Key"], "test-key");
  assert.match(calls[1].url, /result$/);
});

test("WEB_SEARCH_PROVIDER supports Doubao and source combinations", () => {
  const oldMode = process.env.WEB_SEARCH_PROVIDER;
  const oldKey = process.env.REDFOX_API_KEY;
  const oldDeep = process.env.REDFOX_DEEPSEARCH_BASE;
  const oldDeepseekKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.REDFOX_API_KEY = "test-key";
    delete process.env.REDFOX_DEEPSEARCH_BASE;
    process.env.WEB_SEARCH_PROVIDER = "doubao";
    assert.deepEqual(getWebSearchProviderConfig(), { mode: "doubao", aiProvider: "doubao", includeSources: false, includeDeepseek: false, includeDoubao: true, includeRedfoxDeepseek: false });
    process.env.WEB_SEARCH_PROVIDER = "doubao+sources";
    assert.deepEqual(getWebSearchProviderConfig(), { mode: "doubao+sources", aiProvider: "doubao", includeSources: true, includeDeepseek: false, includeDoubao: true, includeRedfoxDeepseek: false });
    process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
    process.env.WEB_SEARCH_PROVIDER = "auto";
    assert.deepEqual(getWebSearchProviderConfig(), { mode: "auto", aiProvider: "both", includeSources: false, includeDeepseek: true, includeDoubao: false, includeRedfoxDeepseek: true });
  } finally {
    if (oldMode === undefined) delete process.env.WEB_SEARCH_PROVIDER; else process.env.WEB_SEARCH_PROVIDER = oldMode;
    if (oldKey === undefined) delete process.env.REDFOX_API_KEY; else process.env.REDFOX_API_KEY = oldKey;
    if (oldDeep === undefined) delete process.env.REDFOX_DEEPSEARCH_BASE; else process.env.REDFOX_DEEPSEARCH_BASE = oldDeep;
    if (oldDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldDeepseekKey;
  }
});
