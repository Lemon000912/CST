import assert from "node:assert/strict";
import test from "node:test";

import { createPerformanceTrace, traceAsync } from "../performanceTrace.js";

test("performance trace records bounded stages and safe metadata", async () => {
  const trace = createPerformanceTrace("request-1");
  const end = trace.start("search.round1", { query: "alpha", secret: { key: "hidden" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  end({ results: 12 });
  end({ results: 99 });

  const snapshot = trace.snapshot();
  assert.equal(snapshot.requestId, "request-1");
  assert.equal(snapshot.stages.length, 1);
  assert.equal(snapshot.stages[0].name, "search.round1");
  assert.equal(snapshot.stages[0].details.query, "alpha");
  assert.equal(snapshot.stages[0].details.results, 12);
  assert.equal(snapshot.stages[0].details.secret, undefined);
  assert.ok(snapshot.stages[0].durationMs >= 0);
});

test("traceAsync records success summaries", async () => {
  const trace = createPerformanceTrace("request-2");
  const result = await traceAsync(
    trace,
    "search.source",
    { source: "test" },
    async () => [1, 2, 3],
    (rows) => ({ results: rows.length }),
  );
  assert.deepEqual(result, [1, 2, 3]);
  assert.equal(trace.snapshot().stages[0].details.results, 3);
});
