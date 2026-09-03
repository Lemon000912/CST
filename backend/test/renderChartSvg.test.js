import test from "node:test";
import assert from "node:assert/strict";
import { renderScatterChartSvg } from "../renderChartSvg.js";

test("SVG chart keeps UTF-8 labels and a CJK-capable font stack", () => {
  const svg = renderScatterChartSvg({
    title: "中文标题",
    x_axis: { label: "年份" },
    y_axis: { label: "效率(%)" },
    points: [{ x: 2024, y: 12.5, paper_title: "中文文献" }],
  });

  assert.ok(svg);
  assert.match(svg, /中文标题/);
  assert.match(svg, /年份/);
  assert.match(svg, /效率\(%\)/);
  assert.match(svg, /Microsoft YaHei, SimHei, PingFang SC, Noto Sans CJK SC/);
});
