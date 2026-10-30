import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "../llmClient.js";
import { createPerformanceTrace } from "../performanceTrace.js";

const provider = { slot: "A", protocol: "openai_chat_completions", apiKey: "secret-credential", baseUrl: "https://synthetic.example/v1", model: "synthetic-model" };
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function sseResponse(chunks) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function capture(t) {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args));
  return { logs, events: () => logs.filter(([tag]) => tag === "[llm-diagnostic]").map(([, data]) => JSON.parse(data)) };
}

test("reasoning-only attempts retain the existing three calls and expose each retry without content", async (t) => {
  const { logs, events } = capture(t);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    const usage = { prompt_tokens: 300, completion_tokens: 6000, completion_tokens_details: { reasoning_tokens: 6000 } };
    if (body.stream) return sseResponse([{ model: "served-model", choices: [{ delta: { reasoning_content: "private-thought" }, finish_reason: "length" }], usage }]);
    return jsonResponse({ model: "served-model", choices: [{ message: { content: "", reasoning_content: "private-thought" }, finish_reason: "length" }], usage });
  });
  const trace = createPerformanceTrace("diagnostic-test-request");
  const result = await generateText(provider, { performanceTrace: trace, system: "private-system", messages: [{ role: "user", content: "private-question" }], maxTokens: 6000, onTextDelta() {} });
  assert.equal(bodies.length, 3);
  assert.equal(result.ok, true, "diagnostics must preserve legacy reasoning-only success semantics");
  assert.equal(result.text, "");
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[1].stream_options, undefined);
  assert.equal(bodies[2].stream, undefined);
  for (const body of bodies) {
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.performanceTrace, undefined);
  }
  const ends = events().filter((e) => e.event === "end");
  assert.deepEqual(ends.map((e) => e.attempt), [1, 2, 3]);
  assert.equal(new Set(ends.map((e) => e.callId)).size, 1);
  assert.equal(new Set(ends.map((e) => e.inputFingerprint)).size, 1);
  for (const end of ends) {
    assert.equal(end.requestId, "diagnostic-test-request");
    assert.equal(end.reasoningTokens, 6000);
    assert.equal(end.outputTokens, 6000);
    assert.equal(end.contentChars, 0);
    assert.equal(end.reasoningChars, 15);
    assert.equal(end.finishReason, "length");
    assert.equal(end.outcome, "reasoning_only");
    assert.ok(end.headersMs >= 0);
    assert.ok(end.firstReasoningMs >= 0);
    assert.equal(end.firstContentMs, undefined);
  }
  assert.deepEqual(events().filter((e) => e.event === "retry").map((e) => e.reason), ["empty", "empty"]);
  assert.equal(trace.snapshot().stages.length, 3);
  const serialized = JSON.stringify(logs);
  for (const secret of ["private-thought", "private-question", "private-system", "secret-credential"]) assert.equal(serialized.includes(secret), false);
});

test("stream diagnostics distinguish first reasoning from first content and preserve output", async (t) => {
  const { events } = capture(t);
  t.mock.method(globalThis, "fetch", async () => sseResponse([
    { choices: [{ delta: { reasoning_content: "hidden" } }] },
    { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
  ]));
  const deltas = [];
  const result = await generateText(provider, { performanceTrace: createPerformanceTrace("request-2"), onTextDelta: (s) => deltas.push(s) });
  assert.equal(result.text, "answer");
  assert.deepEqual(deltas, ["answer"]);
  const end = events().find((e) => e.event === "end");
  assert.equal(end.finishReason, "stop");
  assert.equal(end.contentChars, 6);
  assert.equal(end.reasoningChars, 6);
  assert.ok(end.firstContentMs >= end.firstReasoningMs);
  assert.equal(end.resultOk, true);
  assert.equal(end.httpStatus, 200);
});

test("caller cancellation is distinguished from timeout without adding a retry", async (t) => {
  const { events } = capture(t);
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("cancel", "AbortError")), { once: true }));
  });
  const pending = generateText(provider, { performanceTrace: createPerformanceTrace("request-3"), signal: controller.signal, onTextDelta() {} });
  controller.abort();
  await pending;
  assert.equal(calls, 1);
  assert.equal(events().find((e) => e.event === "end").abortKind, "caller");
});

test("HTTP error bodies and exception messages are not copied into diagnostic fields", async (t) => {
  const { logs, events } = capture(t);
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ error: { message: "private-error-body" } }, 429));
  const result = await generateText(provider, { performanceTrace: createPerformanceTrace("request-4") });
  assert.equal(result.status, 429);
  assert.equal(events().find((e) => e.event === "end").errorCategory, "http_429");
  assert.equal(JSON.stringify(logs).includes("private-error-body"), false);
});

test("logging failures cannot change a successful generation", async (t) => {
  t.mock.method(console, "log", () => { throw new Error("log sink unavailable"); });
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }));
  const result = await generateText(provider, { performanceTrace: createPerformanceTrace("request-5") });
  assert.equal(result.ok, true);
  assert.equal(result.text, "answer");
});
