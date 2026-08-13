import assert from "node:assert/strict";
import test from "node:test";

import { generateText } from "../llmClient.js";
import { LLM_PROTOCOLS } from "../llmProviders.js";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("OpenAI-compatible requests use bearer auth and normalized output", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return response({
      model: "served-model",
      choices: [{ message: { content: "answer", reasoning_content: "reason" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 12,
        total_tokens: 42,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    });
  });
  const provider = Object.freeze({
    slot: "A",
    protocol: LLM_PROTOCOLS.OPENAI,
    apiKey: "secret-a",
    baseUrl: "https://a.example/v1",
    model: "model-a",
  });

  const result = await generateText(provider, {
    system: "system prompt",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.2,
    maxTokens: 123,
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "answer");
  assert.equal(result.reasoningText, "reason");
  assert.equal(result.responseModel, "served-model");
  assert.deepEqual(result.usage, {
    inputTokens: 30,
    outputTokens: 12,
    reasoningTokens: 4,
    cachedInputTokens: 5,
    totalTokens: 42,
  });
  assert.equal(calls[0].url, "https://a.example/v1/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-a");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "model-a");
  assert.equal(body.max_tokens, 123);
  assert.deepEqual(body.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(JSON.stringify(result).includes("secret-a"), false);
});

test("Gemini requests use native generateContent shape and API key header", async (t) => {
  let call;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    call = { url, options };
    return response({
      modelVersion: "gemini-2.5-flash-001",
      candidates: [{
        content: {
          parts: [
            { text: "internal search fragments", thought: true },
            { text: "native answer" },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 3,
        cachedContentTokenCount: 2,
        totalTokenCount: 31,
      },
    });
  });
  const provider = Object.freeze({
    slot: "C",
    protocol: LLM_PROTOCOLS.GEMINI,
    apiKey: "secret-c",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
  });

  const result = await generateText(provider, {
    system: "system prompt",
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "prior answer" },
    ],
    temperature: 0.1,
    maxTokens: 456,
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "native answer");
  assert.equal(result.responseModel, "gemini-2.5-flash-001");
  assert.deepEqual(result.usage, {
    inputTokens: 20,
    outputTokens: 8,
    reasoningTokens: 3,
    cachedInputTokens: 2,
    totalTokens: 31,
  });
  assert.equal(
    call.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  assert.equal(call.options.headers["x-goog-api-key"], "secret-c");
  assert.equal(call.options.headers.Authorization, undefined);
  const body = JSON.parse(call.options.body);
  assert.deepEqual(body.system_instruction, { parts: [{ text: "system prompt" }] });
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "question" }] },
    { role: "model", parts: [{ text: "prior answer" }] },
  ]);
  assert.deepEqual(body.generationConfig, { temperature: 0.1, maxOutputTokens: 456 });
  assert.equal(JSON.stringify(result).includes("secret-c"), false);
});

test("provider HTTP failures are bounded and do not expose keys", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(800), { status: 503 }));
  const provider = {
    slot: "B",
    protocol: LLM_PROTOCOLS.OPENAI,
    apiKey: "secret-b",
    baseUrl: "https://b.example/v1",
    model: "model-b",
  };
  const result = await generateText(provider, { messages: [{ role: "user", content: "hello" }] });
  assert.equal(result.ok, false);
  assert.equal(result.error, "http_503");
  assert.equal(result.errorBody.length, 500);
  assert.equal(JSON.stringify(result).includes("secret-b"), false);
});

function sseResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status, headers: { "Content-Type": "text/event-stream" } });
}

test("OpenAI-compatible streaming emits deltas and preserves final usage", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return sseResponse([
      'data: {"model":"served","choices":[{"delta":{"content":"正文"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"增量"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n',
      "data: [DONE]\n\n",
    ]);
  });
  const provider = {
    slot: "A",
    protocol: LLM_PROTOCOLS.OPENAI,
    apiKey: "secret-a",
    baseUrl: "https://a.example/v1",
    model: "model-a",
  };
  const deltas = [];
  const result = await generateText(provider, {
    messages: [{ role: "user", content: "hello" }],
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "正文增量");
  assert.deepEqual(deltas, ["正文", "增量"]);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2, totalTokens: 9 });
});

test("Gemini streaming uses SSE and excludes thought parts", async (t) => {
  let url;
  t.mock.method(globalThis, "fetch", async (requestUrl) => {
    url = String(requestUrl);
    return sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"思考","thought":true},{"text":"终稿一"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"终稿二"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}\n\n',
    ]);
  });
  const provider = {
    slot: "C",
    protocol: LLM_PROTOCOLS.GEMINI,
    apiKey: "secret-c",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-test",
  };
  const deltas = [];
  const result = await generateText(provider, {
    messages: [{ role: "user", content: "hello" }],
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.match(url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(result.text, "终稿一终稿二");
  assert.deepEqual(deltas, ["终稿一", "终稿二"]);
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
});

test("unsupported streaming falls back to the established non-streaming request", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.stream) return response({ error: { message: "stream unsupported" } }, 400);
    return response({ choices: [{ message: { content: "完整回退" }, finish_reason: "stop" }] });
  });
  const provider = {
    slot: "A",
    protocol: LLM_PROTOCOLS.OPENAI,
    apiKey: "secret-a",
    baseUrl: "https://a.example/v1",
    model: "model-a",
  };
  const deltas = [];
  const result = await generateText(provider, {
    messages: [{ role: "user", content: "hello" }],
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "完整回退");
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.equal(bodies[1].stream, true);
  assert.equal(bodies[1].stream_options, undefined);
  assert.equal(bodies[2].stream, undefined);
  assert.deepEqual(deltas, []);
});

test("a gateway that ignores stream mode is consumed without a duplicate request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return response({
      choices: [{ message: { content: "网关返回的完整正文" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
  });
  const provider = {
    slot: "A",
    protocol: LLM_PROTOCOLS.OPENAI,
    apiKey: "secret-a",
    baseUrl: "https://a.example/v1",
    model: "model-a",
  };
  const deltas = [];
  const result = await generateText(provider, {
    messages: [{ role: "user", content: "hello" }],
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.text, "网关返回的完整正文");
  assert.deepEqual(deltas, ["网关返回的完整正文"]);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
});
