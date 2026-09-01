import test from "node:test";
import assert from "node:assert/strict";
import { rateLimitHit } from "../rateLimit.js";

test("rate limits with different scopes do not consume each other's budget", () => {
  const ip = `scope-test-${Date.now()}-${Math.random()}`;

  assert.equal(rateLimitHit(ip, { max: 1, windowMs: 60_000, scope: "artifact:pptx" }), true);
  assert.equal(rateLimitHit(ip, { max: 1, windowMs: 60_000, scope: "artifact:pptx" }), false);

  assert.equal(rateLimitHit(ip, { max: 1, windowMs: 60_000, scope: "artifact:docx" }), true);
  assert.equal(rateLimitHit(ip, { max: 1, windowMs: 60_000, scope: "artifact:pdf" }), true);
});

test("limits with different thresholds remain independent for legacy callers", () => {
  const ip = `threshold-test-${Date.now()}-${Math.random()}`;

  assert.equal(rateLimitHit(ip, { max: 1, windowMs: 60_000 }), true);
  assert.equal(rateLimitHit(ip, { max: 1, windowMs: 60_000 }), false);
  assert.equal(rateLimitHit(ip, { max: 2, windowMs: 60_000 }), true);
  assert.equal(rateLimitHit(ip, { max: 2, windowMs: 60_000 }), true);
});
