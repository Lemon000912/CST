import test from "node:test";
import assert from "node:assert/strict";
import { fetchRedfoxDeepseekPapers, getRedfoxDeepseekConfig } from "../redfoxDeepseekWebSearch.js";

test("Redfox DeepSeek WebSearch submits, polls and normalizes citations", async () => {
  const old = {
    key: process.env.REDFOX_API_KEY,
    base: process.env.REDFOX_DEEPSEARCH_BASE,
    poll: process.env.REDFOX_DEEPSEARCH_POLL_MS,
    attempts: process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS,
    fetch: globalThis.fetch,
  };
  const calls = [];
  try {
    process.env.REDFOX_API_KEY = "redfox-test-key";
    process.env.REDFOX_DEEPSEARCH_BASE = "https://redfox.test/story/api/deepSearch";
    process.env.REDFOX_DEEPSEARCH_POLL_MS = "500";
    process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS = "1";
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      const body = calls.length === 1
        ? { data: { taskId: "task-1" } }
        : { data: { status: "succeeded", result: JSON.stringify({ content: "Answer", search_result: JSON.stringify([{ title: "Result", url: "https://example.com/a", content: "Summary" }]) }) } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await fetchRedfoxDeepseekPapers("query", 5);
    assert.equal(getRedfoxDeepseekConfig().submitUrl, "https://redfox.test/story/api/deepSearch/dsSubmit");
    assert.equal(calls[0].url, "https://redfox.test/story/api/deepSearch/dsSubmit");
    assert.equal(calls[0].init.headers.REDFOX_API_KEY, "redfox-test-key");
    assert.deepEqual(calls[0].body, { inquiryText: "query", source: "Deepseek WebSearch-GitHub" });
    assert.equal(calls[1].url, "https://redfox.test/story/api/deepSearch/dsResult");
    assert.equal(result.papers[0].source, "deepseek_web");
    assert.equal(result.papers[0].webProviderLabel, "Redfox DeepSeek WebSearch");
    assert.equal(result.papers[0].summary, "Summary");
  } finally {
    if (old.key === undefined) delete process.env.REDFOX_API_KEY; else process.env.REDFOX_API_KEY = old.key;
    if (old.base === undefined) delete process.env.REDFOX_DEEPSEARCH_BASE; else process.env.REDFOX_DEEPSEARCH_BASE = old.base;
    if (old.poll === undefined) delete process.env.REDFOX_DEEPSEARCH_POLL_MS; else process.env.REDFOX_DEEPSEARCH_POLL_MS = old.poll;
    if (old.attempts === undefined) delete process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS; else process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS = old.attempts;
    globalThis.fetch = old.fetch;
  }
});
