import assert from "node:assert/strict";
import test from "node:test";

import { decodeHtmlBuffer, extractHttpUrls, fetchDirectWebPapers } from "../directWebSearch.js";
import { buildWebSearchQueries, executeWebOpenUrlTool, formatWebOpenUrlResult } from "../webSearchTool.js";

test("direct HTML decoding honors a legacy Chinese charset", () => {
  const buffer = Buffer.concat([
    Buffer.from('<meta http-equiv="Content-type" content="text/html; charset=gb2312"><title>', "ascii"),
    Buffer.from([0xd6, 0xd0]),
    Buffer.from("</title>", "ascii"),
  ]);
  assert.match(decodeHtmlBuffer(buffer, "text/html"), /<title>中<\/title>/);
});

test("a successful explicit URL does not suppress complementary SERP queries", () => {
  const queries = buildWebSearchQueries(
    "核对苯乙烯2026年产能利用率 https://example.com/report.html",
    "data",
    4,
  );
  assert.ok(queries.length > 0);
  assert.ok(queries.every((query) => !query.includes("https://")));
  assert.deepEqual(buildWebSearchQueries("https://example.com/report.html"), []);
});

test("extractHttpUrls deduplicates explicit URLs and removes PDF viewer fragments", () => {
  const urls = extractHttpUrls(
    "请核对 https://example.com/report.pdf#page=2#2 和 https://example.com/report.pdf#other。",
  );
  assert.deepEqual(urls, ["https://example.com/report.pdf"]);
});

test("direct URL fetch blocks private hosts before making a request", async () => {
  const result = await fetchDirectWebPapers(["http://127.0.0.1:8787/api/health"], {
    timeoutMs: 5_000,
  });
  assert.equal(result.papers.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /not allowed|unreachable|non-public/i);
});

test("web_open_url reports URL read failures instead of silently treating them as evidence", async () => {
  const result = await executeWebOpenUrlTool({ urls: ["http://127.0.0.1:8787/api/health"] });
  assert.equal(result.success, false);
  assert.equal(result.count, 0);
  assert.equal(result.failures.length, 1);
  assert.match(formatWebOpenUrlResult(result), /无法读取的 URL/);
});
