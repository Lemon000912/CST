import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeBookFromWebClues } from "../bookWebSynthesize.js";
import { extractDataTableByType } from "../dataTableExtract.js";
import { extractChartSpecWithLlm } from "../paperChart.js";

function withPrimaryEnv(fn) {
  const names = ["LLM_API_KEY", "LLM_CHAT_COMPLETIONS_URL", "LLM_MODEL"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.LLM_API_KEY = "server-secret";
  process.env.LLM_CHAT_COMPLETIONS_URL = "https://primary.example/v1";
  process.env.LLM_MODEL = "primary-model";
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function jsonResponse(content) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], model: "primary-model" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("chart extraction uses primary provider without unresolved legacy helpers", async (t) => {
  let call;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    call = { url, options };
    return jsonResponse(
      JSON.stringify({
        title: "chart",
        x_axis: { label: "year" },
        y_axis: { label: "value" },
        chart_type: "scatter",
        points: [{ x: 2024, y: 12.5, paper_index: 1, quote: "12.5%" }],
      }),
    );
  });

  const result = await withPrimaryEnv(() =>
    extractChartSpecWithLlm(
      [{ title: "Paper", year: 2024, doi: "10.1/test", summary: "The value was 12.5%." }],
      { apiKey: "", chatCompletionsUrl: "https://attacker.example/v1" },
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(result.spec.title, "chart");
  assert.equal(call.url, "https://primary.example/v1/chat/completions");
  assert.equal(call.options.headers.Authorization, "Bearer server-secret");
});

test("data table extraction preserves response structure", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse(JSON.stringify({ title: "性能表", rows: [{ metric: "PCE", value: "24.5", unit: "%", source_ref: "[1]" }] })),
  );

  const result = await withPrimaryEnv(() =>
    extractDataTableByType({
      tableType: "performance",
      papers: [{ title: "Paper", doi: "10.1/test", summary: "PCE reached 24.5%." }],
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.tableType, "performance");
  assert.equal(result.title, "性能表");
  assert.equal(result.rows.length, 1);
  assert.match(result.note, /^data_table:ok/);
});

test("book synthesis keeps UI metadata and does not return credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse("这本书介绍公开方法。〔1〕\n\n## 第一章\n公开摘录中的章节信息。〔1〕"),
  );

  const result = await withPrimaryEnv(() =>
    synthesizeBookFromWebClues({
      userQuery: "请按章节总结《测试之书》",
      papers: [{ title: "测试之书目录", absUrl: "https://books.example/test", summary: "第一章：公开方法" }],
    }),
  );
  assert.ok(result.markdown);
  assert.equal(result.synthesisModels.modelA, "primary-model");
  assert.equal(result.synthesisModels.mode, "book_web_clues");
  assert.equal(JSON.stringify(result).includes("server-secret"), false);
});
