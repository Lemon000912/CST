import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { enrichPapersWithWebPageContent, fetchWebPageText } from "../webPageIngest.js";

const ENV_NAMES = [
  "WEB_FETCH_ENABLED",
  "WEB_FETCH_CONCURRENCY",
  "WEB_FETCH_TIMEOUT_MS",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_FETCH_URL",
  "DATAIFY_API_KEY",
  "DATAIFY_WEBUNLOCKER_ENABLED",
  "DATAIFY_WEBUNLOCKER_MODE",
];

async function withEnv(values, fn) {
  const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("enrichPapersWithWebPageContent merges fetched text and title without scope errors", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><html><head><title>Fetched page title</title></head><body>" +
      "This is a sufficiently long body extracted from the fetched page for regression testing. " +
      "It must exceed the minimum text threshold." +
      "</body></html>",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/article`;

  try {
    await withEnv({ WEB_FETCH_ENABLED: "1", WEB_FETCH_CONCURRENCY: "1" }, async () => {
      const input = [{
        id: "paper-1",
        source: "ddg_web",
        title: url,
        absUrl: url,
        summary: "short",
      }];
      const result = await enrichPapersWithWebPageContent(input, {
        maxPages: 1,
        timeoutMs: 5_000,
      });

      assert.equal(result.fetched, 1);
      assert.equal(result.errors, 0);
      assert.equal(result.attempted, 1);
      assert.equal(result.papers[0].title, "Fetched page title");
      assert.match(result.papers[0].summary, /sufficiently long body extracted/);
      assert.equal(result.papers[0].webFetchNote, "fetched");
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("public WeChat article prefers the configured model-side fetch before direct access", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (!String(url).includes("fetch.example.test")) {
      throw new Error("direct access should not run after model-side success");
    }
    return new Response(JSON.stringify({
      data: {
        title: "公众号文章标题",
        content: "这是通过模型侧 Fetch 读取到的公开公众号文章正文，内容足够长，可以交给后续联网综合模型使用。",
        url: "https://mp.weixin.qq.com/s/example-article",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await withEnv({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_FETCH_URL: "https://fetch.example.test/page",
      WEB_PAGE_TOTAL_TIMEOUT_MS: "5000",
    }, async () => {
      const result = await fetchWebPageText("https://mp.weixin.qq.com/s/example-article", 5000);
      assert.equal(result.ok, true);
      assert.equal(result.via, "deepseek_fetch");
      assert.equal(result.title, "公众号文章标题");
      assert.match(result.text, /模型侧 Fetch 读取到/);
      assert.deepEqual(calls, ["https://fetch.example.test/page"]);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

