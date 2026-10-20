import test from "node:test";
import assert from "node:assert/strict";

import { fetchDeepseekWebPage, fetchDeepseekWebPapers, getDeepseekWebSearchConfig } from "../deepseekWebSearch.js";

const restoreEnv = (key, value) => value === undefined ? delete process.env[key] : process.env[key] = value;

test("official DeepSeek adapter is disabled without its dedicated API key", async (t) => {
  const old = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => restoreEnv("DEEPSEEK_API_KEY", old));
  assert.equal(getDeepseekWebSearchConfig(), null);
  assert.equal((await fetchDeepseekWebPapers("工业数据", 5)).note, "not-configured");
  assert.equal((await fetchDeepseekWebPage("https://example.com")).error, "not-configured");
});

test("official Search normalizes source links and uses bearer auth", async (t) => {
  const old = {
    key: process.env.DEEPSEEK_API_KEY,
    base: process.env.DEEPSEEK_TOOLS_BASE_URL,
    fetch: globalThis.fetch,
  };
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_TOOLS_BASE_URL = "https://deepseek.test/v1/tools";
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ results: [
      { title: "来源标题", url: "https://example.com/report", snippet: "页面摘要", date: "2025-04-02" },
    ] }), { status: 200 });
  };
  t.after(() => {
    restoreEnv("DEEPSEEK_API_KEY", old.key);
    restoreEnv("DEEPSEEK_TOOLS_BASE_URL", old.base);
    globalThis.fetch = old.fetch;
  });
  const result = await fetchDeepseekWebPapers("工业数据", 5);
  assert.equal(request.url, "https://deepseek.test/v1/tools/search");
  assert.equal(request.headers.Authorization, "Bearer test-key");
  assert.deepEqual(request.body, { query: "工业数据", count: 5 });
  assert.equal(result.papers[0].absUrl, "https://example.com/report");
  assert.equal(result.papers[0].title, "来源标题");
  assert.equal(result.papers[0].summary, "页面摘要");
  assert.equal(result.papers[0].year, 2025);
});

test("official Search enforces the 128 Unicode code point query limit", async (t) => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  t.after(() => { restoreEnv("DEEPSEEK_API_KEY", oldKey); globalThis.fetch = oldFetch; });
  await fetchDeepseekWebPapers("界".repeat(130), 99);
  assert.equal(Array.from(body.query).length, 128);
  assert.equal(body.count, 50);
});

test("official Fetch returns title and extracted page content", async (t) => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/fetch$/);
    assert.deepEqual(JSON.parse(init.body), { url: "https://example.com/article" });
    return new Response(JSON.stringify({ title: "文章标题", content: "这是一段足够长的网页正文内容，用于确认官方 Fetch 的标题和正文可以被网页抓取模块接收。" }), { status: 200 });
  };
  t.after(() => { restoreEnv("DEEPSEEK_API_KEY", oldKey); globalThis.fetch = oldFetch; });
  const result = await fetchDeepseekWebPage("https://example.com/article");
  assert.equal(result.ok, true);
  assert.equal(result.title, "文章标题");
  assert.match(result.text, /网页正文内容/);
  assert.equal(result.via, "deepseek_fetch");
});
