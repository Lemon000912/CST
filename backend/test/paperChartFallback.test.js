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

test("chart fallback honors a metric hint when no LLM is available", () => {
  const papers = [
    {
      id: "web-elong-1",
      source: "tavily_web",
      absUrl: "https://example.com/elong-1",
      year: 2022,
      summary: "The electrode reached 3.8 V and a tensile elongation of 120%.",
    },
    {
      id: "web-elong-2",
      source: "tavily_web",
      absUrl: "https://example.com/elong-2",
      year: 2023,
      summary: "At 4.0 V, the tensile elongation increased to 145%.",
    },
  ];

  const fallback = buildFallbackChartSpecFromAbstracts(papers, { hint: "拉伸率" });
  assert.ok(fallback);
  assert.equal(fallback.y_axis.label, "百分数 (%)");
  assert.deepEqual(fallback.points.map((point) => point.y), [120, 145]);
});

test("chart fallback recognizes common material strength units", () => {
  const papers = [
    { id: "strength-1", source: "tavily_web", absUrl: "https://example.com/s1", year: 2022, summary: "Tensile strength reached 1.2 GPa." },
    { id: "strength-2", source: "tavily_web", absUrl: "https://example.com/s2", year: 2023, summary: "The measured strength was 950 MPa." },
  ];
  const fallback = buildFallbackChartSpecFromAbstracts(papers, { hint: "拉伸强度" });
  assert.ok(fallback);
  assert.equal(fallback.y_axis.label, "强度 (MPa)");
  assert.deepEqual(fallback.points.map((point) => point.y), [1200, 950]);
});

test("chart fallback recognizes temperature values with a hint", () => {
  const papers = [
    { id: "temp-1", source: "tavily_web", absUrl: "https://example.com/t1", year: 2022, summary: "The test was performed at 300 K." },
    { id: "temp-2", source: "tavily_web", absUrl: "https://example.com/t2", year: 2023, summary: "The test temperature was 50 °C." },
  ];
  const fallback = buildFallbackChartSpecFromAbstracts(papers, { hint: "温度" });
  assert.ok(fallback);
  assert.equal(fallback.y_axis.label, "温度 (°C)");
  assert.deepEqual(fallback.points.map((point) => Math.round(point.y * 10) / 10), [26.9, 50]);
});
