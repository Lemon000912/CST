import assert from "node:assert/strict";
import test from "node:test";

import { createSynthesisStreamEmitter } from "../synthesisStream.js";
import { finalizeSynthesisMarkdown, normalizeMalformedMarkdownTables, parseSynthesisOutput } from "../synthesisExtract.js";

test("malformed joined Markdown table rows are restored before rendering", () => {
  const raw = "| 指标 | 数值 | 单位 | 条件 | 来源 || --- | --- | --- | --- | --- || 单丝直径 | ≤9 | 微米 | 电子级玻璃纤维纱 | [2] || 幅宽 | 1270 | mm | 7628型号 | [1]";
  const normalized = normalizeMalformedMarkdownTables(raw);
  assert.equal(normalized.split("\n").length, 4);
  const finalized = finalizeSynthesisMarkdown(raw);
  assert.match(finalized.markdown, /\n\|---/);
  assert.equal(finalized.markdown.split("\n").length, 4);
});

test("pipe-heavy text in code fences is left untouched by table normalization", () => {
  const raw = "```text\n| a || b |\n```";
  assert.equal(normalizeMalformedMarkdownTables(raw), raw);
});

test("invalid structured JSON footer is removed from visible markdown", () => {
  const parsed = parseSynthesisOutput(
    "正文结论\n\n```json\n{\"extractedData\":[{\"source_ref\":\"[5](https://example.com/a)\"}]\n```",
  );
  assert.equal(parsed.markdown, "正文结论");
  assert.equal(parsed.plan, null);
  assert.equal(parsed.planNote, "synth_plan:parse_error");
});

test("structured JSON fence is removed even when a provider appends trailing text", () => {
  const parsed = parseSynthesisOutput(
    "正文结论\n\n```json\n{\"extractedData\":[],\"steps\":[]}\n```\n\n后续说明",
  );
  assert.equal(parsed.markdown, "正文结论\n\n后续说明");
  assert.equal(parsed.planNote, "synth_plan:ok_no_data");
});

test("spaced json fence is treated as a structured footer", () => {
  const parsed = parseSynthesisOutput(
    "正文结论\n\n``` json\n{\"extractedData\":[],\"steps\":[]}\n```",
  );
  assert.equal(parsed.markdown, "正文结论");
  assert.equal(parsed.planNote, "synth_plan:ok_no_data");
});

test("truncated structured JSON is hidden instead of rendered as正文", () => {
  const parsed = parseSynthesisOutput(
    "正文结论\n\n```json\n{\"extractedData\":[{\"metric\":\"活性\",\"value\":\"11.8\"}]",
  );
  assert.equal(parsed.markdown, "正文结论");
  assert.equal(parsed.plan, null);
  assert.equal(parsed.planNote, "synth_plan:parse_error");
});

test("raw structured JSON with a valid object is split from正文", () => {
  const parsed = parseSynthesisOutput(
    "正文结论\n\n{\"extractedData\":[{\"metric\":\"活性\",\"value\":\"11.8\"}],\"steps\":[]}",
  );
  assert.equal(parsed.markdown, "正文结论");
  assert.equal(parsed.plan?.extractedData?.[0]?.value, "11.8");
});

test("raw structured JSON keeps trailing human-readable text", () => {
  const parsed = parseSynthesisOutput(
    "正文结论\n\n{\"extractedData\":[],\"steps\":[]}\n\n补充说明",
  );
  assert.equal(parsed.markdown, "正文结论\n\n补充说明");
  assert.equal(parsed.planNote, "synth_plan:ok_inline_no_data");
});

test("legacy metric aliases are recognized as structured plan fields", () => {
  const parsed = parseSynthesisOutput(
    "正文结论\n\n```json\n{\"metrics\":[{\"metric\":\"温度\",\"value\":\"100\",\"unit\":\"℃\"}]}\n```",
  );
  assert.equal(parsed.planNote, "synth_plan:ok");
  assert.equal(parsed.plan?.extractedData?.[0]?.metric, "温度");
  assert.equal(parsed.plan?.extractedData?.[0]?.value, "100");
});

test("finalization derives structured data and steps from markdown when JSON is omitted", () => {
  const finalized = finalizeSynthesisMarkdown(
    "## 关键数据与指标\n\n| 指标 | 数值 | 单位 | 条件 | 来源 |\n| --- | --- | --- | --- | --- |\n| 产率 | 92 | % | 800℃ | [2] |\n\n## 工序流程\n\n1. 混合原料\n2. 在 800℃ 烧结",
  );
  assert.equal(finalized.planNote, "synth_plan:derived_from_markdown");
  assert.deepEqual(finalized.plan?.extractedData, [
    { metric: "产率", value: "92", unit: "%", condition: "800℃", source_ref: "[2]" },
  ]);
  assert.deepEqual(finalized.plan?.steps, [
    { step_no: 1, action: "混合原料" },
    { step_no: 2, action: "在 800℃ 烧结" },
  ]);
});

test("finalization returns an empty structured plan rather than no plan", () => {
  const finalized = finalizeSynthesisMarkdown("## 核心结论\n\n没有可核对的数字或工艺步骤。");
  assert.deepEqual(finalized.plan, { extractedData: [], steps: [] });
  assert.equal(finalized.planNote, "synth_plan:derived_from_markdown");
});

test("synthesis stream hides a split structured JSON footer and reconciles final markdown", () => {
  const events = [];
  const stream = createSynthesisStreamEmitter((event, data) => events.push({ event, data }));
  stream.push("正文第一段\n\n```j");
  stream.push('son\n{"steps":[]}\n```');
  stream.finish("正文第一段");

  assert.equal(
    events.filter((x) => x.event === "synthesis_token").map((x) => x.data.token).join(""),
    "正文第一段\n\n",
  );
  assert.deepEqual(events.at(-1), {
    event: "synthesis_replace",
    data: { synthesis: "正文第一段" },
  });
  assert.equal(JSON.stringify(events).includes("steps"), false);
});

test("synthesis stream hides a spaced json fence before it reaches the client", () => {
  const events = [];
  const stream = createSynthesisStreamEmitter((event, data) => events.push({ event, data }));
  stream.push("正文结论\n\n```  js");
  stream.push("on\n{\"extractedData\":[],\"steps\":[]}\n```");
  stream.finish("正文结论");

  assert.equal(events.filter((x) => x.event === "synthesis_token").map((x) => x.data.token).join(""), "正文结论\n\n");
  assert.equal(JSON.stringify(events).includes("extractedData"), false);
});

test("synthesis stream hides an unfenced raw structured JSON footer", () => {
  const events = [];
  const stream = createSynthesisStreamEmitter((event, data) => events.push({ event, data }));
  stream.push("正文结论\n\n{\n  \"extractedData\": [{\"metric\": \"年份\", \"value\": \"1991\"}],\n  \"steps\": []\n}");
  stream.finish("正文结论");

  assert.equal(events.filter((x) => x.event === "synthesis_token").map((x) => x.data.token).join(""), "正文结论\n\n");
  assert.equal(JSON.stringify(events).includes("extractedData"), false);
});

test("synthesis stream hides raw JSON footers that use legacy metric aliases", () => {
  const events = [];
  const stream = createSynthesisStreamEmitter((event, data) => events.push({ event, data }));
  stream.push("正文结论\n\n{\"metrics\":[{\"metric\":\"年份\",\"value\":\"1991\"}]}");
  stream.finish("正文结论");

  assert.equal(events.filter((item) => item.event === "synthesis_token").map((item) => item.data.token).join(""), "正文结论\n\n");
  assert.equal(JSON.stringify(events).includes("metrics"), false);
});

test("synthesis stream emits normal text incrementally without a replacement", () => {
  const events = [];
  const stream = createSynthesisStreamEmitter((event, data) => events.push({ event, data }));
  stream.push("一个足够长的正文片段，应该在模型仍输出时就到达客户端。");
  assert.equal(stream.hasEmitted(), true);
  stream.finish("一个足够长的正文片段，应该在模型仍输出时就到达客户端。");
  assert.equal(events.some((x) => x.event === "synthesis_replace"), false);
  assert.equal(events.map((x) => x.data.token ?? "").join(""), "一个足够长的正文片段，应该在模型仍输出时就到达客户端。");
});

test("synthesis stream sends an atomic result when the provider did not stream", () => {
  const events = [];
  const stream = createSynthesisStreamEmitter((event, data) => events.push({ event, data }));
  stream.finish("回退后的完整正文");
  assert.deepEqual(events, [{ event: "synthesis_token", data: { token: "回退后的完整正文" } }]);
});

test("synthesis stream stops exactly at the affordable Unicode character limit", () => {
  const events = [];
  let limitReached = 0;
  const stream = createSynthesisStreamEmitter(
    (event, data) => events.push({ event, data }),
    {
      maxVisibleCodePoints: 4,
      onLimitReached: () => { limitReached += 1; },
    },
  );

  stream.push("A😀中文B以及不会输出的后文");
  stream.finish("A😀中文B以及不会输出的终稿");

  const shown = events
    .filter((item) => item.event === "synthesis_token")
    .map((item) => item.data.token)
    .join("");
  assert.equal(shown, "A😀中文");
  assert.equal(Array.from(stream.getVisibleText()).length, 4);
  assert.equal(stream.isLimitReached(), true);
  assert.equal(limitReached, 1);
});
