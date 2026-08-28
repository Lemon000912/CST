import test from "node:test";
import assert from "node:assert/strict";

import { buildFallbackChartSpecFromAbstracts, normalizeChartSpec } from "../paperChart.js";

test("chart fallback keeps one comparable metric instead of mixing units", () => {
  const papers = [
    {
      id: "web-1",
      source: "tavily_web",
      absUrl: "https://example.com/1",
      year: 2022,
      summary: "The cell delivered 180 mAh/g at 3.7 V with 91% retention.",
    },
    {
      id: "web-2",
      source: "tavily_web",
      absUrl: "https://example.com/2",
      year: 2023,
      summary: "A specific capacity of 205 mAh/g was reported.",
    },
    {
      id: "web-3",
      source: "tavily_web",
      absUrl: "https://example.com/3",
      year: 2024,
      summary: "The nominal voltage was 4.2 V.",
    },
  ];

  const fallback = buildFallbackChartSpecFromAbstracts(papers);
  assert.ok(fallback);
  assert.equal(fallback.y_axis.label, "比容量 (mAh/g)");
  assert.deepEqual(fallback.points.map((point) => point.y), [180, 205]);
  assert.ok(fallback.points.every((point) => /mAh\/g/i.test(point.quote)));

  const normalized = normalizeChartSpec(fallback, papers);
  assert.equal(normalized.points.length, 2);
});

test("chart fallback refuses unrelated generic numbers", () => {
  const fallback = buildFallbackChartSpecFromAbstracts([
    {
      id: "web-generic",
      source: "tavily_web",
      absUrl: "https://example.com/generic",
      summary: "The report discusses 12 companies across 8 regions in 2024.",
    },
  ]);
  assert.equal(fallback, null);
});
