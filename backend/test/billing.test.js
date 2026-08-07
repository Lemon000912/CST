import test from "node:test";
import assert from "node:assert/strict";
import {
  POINT_UNITS,
  PRICE_UNITS,
  PRICING_CATALOG,
  SIGNUP_GRANT_UNITS,
  calculateCostUnits,
  countUnicodeCodePoints,
  formatPointUnits,
  stableRequestHash,
  stableStringify,
} from "../billing.js";

test("pricing catalog uses integer units", () => {
  assert.equal(POINT_UNITS, 20);
  assert.equal(SIGNUP_GRANT_UNITS, 20_000);
  assert.deepEqual(PRICE_UNITS, { character: 1, chartPoint: 2, pdf: 20 });
  assert.equal(PRICING_CATALOG.unitsPerPoint, 20);
  assert.equal(calculateCostUnits({ characterCount: 3, chartPointCount: 4, pdfCount: 2 }), 51);
});

test("Unicode count uses code points rather than UTF-16 code units", () => {
  assert.equal(countUnicodeCodePoints("论文"), 2);
  assert.equal(countUnicodeCodePoints("A😀B"), 3);
  assert.equal(countUnicodeCodePoints("é"), 2, "combining marks remain distinct code points");
  assert.equal(countUnicodeCodePoints("👨‍👩‍👧‍👦"), 7, "ZWJ sequence is counted by code point");
  assert.equal(countUnicodeCodePoints(null), 0);
});

test("point formatting is exact for positive and negative integer units", () => {
  assert.equal(formatPointUnits(20_000), "1000.00");
  assert.equal(formatPointUnits(1), "0.05");
  assert.equal(formatPointUnits(2), "0.10");
  assert.equal(formatPointUnits(19), "0.95");
  assert.equal(formatPointUnits(-1), "-0.05");
  assert.equal(formatPointUnits(-21), "-1.05");
  assert.throws(() => formatPointUnits(1.5), /safe integer/);
});

test("stable request hashes ignore object key insertion order", () => {
  const first = { query: "量子", options: { years: [2024, 2025], deep: true } };
  const second = { options: { deep: true, years: [2024, 2025] }, query: "量子" };
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(stableRequestHash(first), stableRequestHash(second));
  assert.notEqual(stableRequestHash(first), stableRequestHash({ ...second, query: "材料" }));
  assert.match(stableRequestHash(first), /^[a-f0-9]{64}$/);
});

test("stable hashing rejects ambiguous unsupported values", () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => stableRequestHash(circular), /circular/i);
  assert.throws(() => stableRequestHash({ value: Number.NaN }), /non-finite/i);
});

test("cost calculation rejects invalid quantities", () => {
  assert.throws(() => calculateCostUnits({ characterCount: -1 }), /non-negative/);
  assert.throws(() => calculateCostUnits({ pdfCount: 1.5 }), /non-negative/);
});
