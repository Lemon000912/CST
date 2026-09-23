import test from "node:test";
import assert from "node:assert/strict";
import { buildMermaidFlowchart, collectProcessSteps } from "../processArtifacts.js";

function steps(count) {
  return Array.from({ length: count }, (_, i) => ({
    step_no: i + 1,
    action: `工艺步骤 ${i + 1}`,
  }));
}

test("short process flowcharts use an explicit vertical layout", () => {
  const mermaid = buildMermaidFlowchart(steps(8), { title: "短流程" });

  assert.match(mermaid, /subgraph main/);
  assert.match(mermaid, /direction TB/);
  assert.doesNotMatch(mermaid, /subgraph phase/);
  assert.match(mermaid, /S7 --> S8/);
});

test("long process flowcharts put horizontal recipe components above vertical steps", () => {
  const mermaid = buildMermaidFlowchart(steps(14), {
    title: "长流程",
    recipeLines: ["原料 A", "原料 B", "溶剂 C"],
  });

  assert.match(mermaid, /subgraph recipe\["配方 \/ 组分"\]/);
  assert.match(mermaid, /subgraph recipeRow1/);
  assert.match(mermaid, /direction LR/);
  assert.match(mermaid, /R0 ~~~ R1/);
  assert.match(mermaid, /R1 ~~~ R2/);
  assert.doesNotMatch(mermaid, /R0 --> R1/);
  assert.match(mermaid, /recipe --> S1/);
  assert.match(mermaid, /subgraph main/);
  assert.match(mermaid, /direction TB/);
  assert.match(mermaid, /S13 --> S14/);
  assert.doesNotMatch(mermaid, /subgraph phase/);
});

test("large composition groups wrap after five components per row", () => {
  const recipes = Array.from({ length: 12 }, (_, i) => `组分 ${i + 1}`);
  const mermaid = buildMermaidFlowchart(steps(14), { recipeLines: recipes });

  assert.match(mermaid, /subgraph recipeRow1/);
  assert.match(mermaid, /subgraph recipeRow2/);
  assert.match(mermaid, /subgraph recipeRow3/);
  assert.match(mermaid, /R3 ~~~ R4/);
  assert.match(mermaid, /R8 ~~~ R9/);
  assert.match(mermaid, /R10 ~~~ R11/);
  assert.match(mermaid, /recipe --> S1/);
  assert.match(mermaid, /R11\["组分 12"\]/);
});

test("long workflows without recipe data stay vertical without fabricated components", () => {
  const mermaid = buildMermaidFlowchart(steps(14), { title: "长流程" });

  assert.match(mermaid, /direction TB/);
  assert.match(mermaid, /S13 --> S14/);
  assert.doesNotMatch(mermaid, /subgraph recipe/);
});

test("structured steps are canonical and are not duplicated by markdown steps", () => {
  const structured = steps(6).map((step) => ({
    ...step,
    action: `**步骤 ${step.step_no}**：${step.action}`,
  }));
  const markdown = [
    "### 工序流程",
    ...steps(6).map((step) => `${step.step_no}. **步骤 ${step.step_no}**: ${step.action}`),
  ].join("\n");

  const result = collectProcessSteps({ steps: structured }, markdown);

  assert.equal(result.length, 6);
  assert.deepEqual(result.map((step) => step.step_no), [1, 2, 3, 4, 5, 6]);
});

test("markdown workflow extraction remains the fallback without structured steps", () => {
  const markdown = [
    "### 工序流程",
    "1. 原料准备",
    "2. 混合处理",
    "3. 后处理",
  ].join("\n");

  const result = collectProcessSteps({ steps: [] }, markdown);

  assert.equal(result.length, 3);
  assert.deepEqual(result.map((step) => step.action), ["原料准备", "混合处理", "后处理"]);
});
