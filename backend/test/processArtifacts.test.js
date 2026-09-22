import test from "node:test";
import assert from "node:assert/strict";
import { buildMermaidFlowchart } from "../processArtifacts.js";

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

test("long process flowcharts are split into vertical stages", () => {
  const mermaid = buildMermaidFlowchart(steps(14), { title: "长流程" });

  assert.match(mermaid, /subgraph phase1/);
  assert.match(mermaid, /subgraph phase2/);
  assert.match(mermaid, /subgraph phase3/);
  assert.match(mermaid, /direction TB/);
  assert.match(mermaid, /S5 --> S6/);
  assert.match(mermaid, /S10 --> S11/);
  assert.doesNotMatch(mermaid, /subgraph main/);
});
