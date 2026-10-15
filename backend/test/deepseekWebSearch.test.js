import test from "node:test";
import assert from "node:assert/strict";

import {
  extractDeepseekCitations,
  fetchDeepseekWebPapers,
  getDeepseekWebSearchConfig,
} from "../deepseekWebSearch.js";

test("DeepSeek citations accept nested search_result URLs", () => {
  const rows = extractDeepseekCitations({
    results: [
      { title: "国家统计局", url: "https://www.stats.gov.cn/report", snippet: "工业数据" },
      { link: "https://example.com/a", name: "Example" },
    ],
  }, "answer");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "国家统计局");
});

test("DeepSeek adapter is disabled without a server-side key", async () => {
  const old = process.env.REDFOX_API_KEY;
  delete process.env.REDFOX_API_KEY;
  try {
    assert.equal(getDeepseekWebSearchConfig(), null);
    const result = await fetchDeepseekWebPapers("工业数据", 5);
    assert.equal(result.note, "not-configured");
    assert.equal(result.papers.length, 0);
  } finally {
    if (old === undefined) delete process.env.REDFOX_API_KEY;
    else process.env.REDFOX_API_KEY = old;
  }
});

test("DeepSeek adapter submits and polls a completed task", async (t) => {
  const oldKey = process.env.REDFOX_API_KEY;
  const oldBase = process.env.REDFOX_DEEPSEARCH_BASE;
  const oldPoll = process.env.REDFOX_DEEPSEARCH_POLL_MS;
  const oldAttempts = process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS;
  const oldFetch = globalThis.fetch;
  process.env.REDFOX_API_KEY = "test-key";
  process.env.REDFOX_DEEPSEARCH_BASE = "https://redfox.test/deep";
  process.env.REDFOX_DEEPSEARCH_POLL_MS = "1";
  process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS = "2";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (calls.length === 1) return new Response(JSON.stringify({ data: { taskId: "task-1" } }), { status: 200 });
    return new Response(JSON.stringify({ data: { status: "succeeded", result: {
      content: "答案",
      search_result: [{ title: "来源", url: "https://example.com/report", snippet: "证据" }],
    } } }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.REDFOX_API_KEY; else process.env.REDFOX_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.REDFOX_DEEPSEARCH_BASE; else process.env.REDFOX_DEEPSEARCH_BASE = oldBase;
    if (oldPoll === undefined) delete process.env.REDFOX_DEEPSEARCH_POLL_MS; else process.env.REDFOX_DEEPSEARCH_POLL_MS = oldPoll;
    if (oldAttempts === undefined) delete process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS; else process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS = oldAttempts;
  });
  const result = await fetchDeepseekWebPapers("工业数据", 5);
  assert.equal(result.note, "ok:1");
  assert.equal(result.papers[0].source, "deepseek_web");
  assert.equal(calls[0].body.source, "Deepseek WebSearch-Project");
  assert.equal(calls[0].headers.REDFOX_API_KEY, "test-key");
  assert.match(calls[1].url, /dsResult$/);
});
