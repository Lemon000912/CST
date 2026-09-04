import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { enrichPapersWithWebPageContent } from "../webPageIngest.js";

const ENV_NAMES = [
  "WEB_FETCH_ENABLED",
  "WEB_FETCH_CONCURRENCY",
  "WEB_FETCH_TIMEOUT_MS",
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

