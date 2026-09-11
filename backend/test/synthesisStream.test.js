import assert from "node:assert/strict";
import test from "node:test";

import { createSynthesisStreamEmitter } from "../synthesisStream.js";
import { parseSynthesisOutput } from "../synthesisExtract.js";

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
