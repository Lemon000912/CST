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
