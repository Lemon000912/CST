import test from "node:test";
import assert from "node:assert/strict";

import { fetchWithTimeout, raceWithTimeout } from "../fetchWithTimeout.js";

test("raceWithTimeout exits immediately when the search is aborted", async () => {
  const controller = new AbortController();
  const never = new Promise(() => {});
  const started = Date.now();
  const result = raceWithTimeout([{ name: "slow-source", promise: never }], 30_000, {
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(result, (error) => error?.name === "AbortError");
  assert.ok(Date.now() - started < 1_000);
});

test("fetchWithTimeout forwards an external abort to the underlying fetch", async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal;
  globalThis.fetch = (_url, options) => {
    receivedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  };

  try {
    const controller = new AbortController();
    const request = fetchWithTimeout("https://example.test", { signal: controller.signal }, 30_000);
    controller.abort();
    await assert.rejects(request, (error) => error?.name === "AbortError");
    assert.equal(receivedSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
