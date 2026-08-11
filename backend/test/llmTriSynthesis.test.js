import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeFromPapers } from "../synthesize.js";

const PROVIDER_ENV = [
  ...["A", "B", "C"].flatMap((slot) => [
    `LLM_PROVIDER_${slot}_PROTOCOL`,
    `LLM_PROVIDER_${slot}_API_KEY`,
    `LLM_PROVIDER_${slot}_BASE_URL`,
    `LLM_PROVIDER_${slot}_MODEL`,
    `SYNTHESIS_API_KEY_${slot}`,
    `SYNTHESIS_CHAT_URL_${slot}`,
    `SYNTHESIS_MODEL_${slot}`,
  ]),
  "LLM_API_KEY",
  "LLM_CHAT_COMPLETIONS_URL",
  "LLM_MODEL",
  "LLM_MODEL_C",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "GOOGLE_GEMINI_BASE_URL",
];

function withTriEnv(fn) {
  const previous = new Map(PROVIDER_ENV.map((name) => [name, process.env[name]]));
  for (const name of PROVIDER_ENV) delete process.env[name];
  Object.assign(process.env, {
    LLM_PROVIDER_A_API_KEY: "key-a",
    LLM_PROVIDER_A_BASE_URL: "https://a.example/v1",
    LLM_PROVIDER_A_MODEL: "model-a",
    LLM_PROVIDER_B_API_KEY: "key-b",
    LLM_PROVIDER_B_BASE_URL: "https://b.example/v1",
    LLM_PROVIDER_B_MODEL: "model-b",
    LLM_PROVIDER_C_API_KEY: "key-c",
    LLM_PROVIDER_C_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
    LLM_PROVIDER_C_MODEL: "gemini-2.5-flash",
  });
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function openAiResponse(text, model) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], model }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("literature tri synthesis uses separate A/B providers and native Gemini C arbitration", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("a.example")) {
      return openAiResponse("## A\n\nA draft [1]", "model-a");
    }
    if (String(url).includes("b.example")) {
      return openAiResponse("## B\n\nB draft [1]", "model-b");
    }
    return new Response(
      JSON.stringify({
        modelVersion: "gemini-2.5-flash-001",
        candidates: [{ content: { parts: [{ text: "## Final\n\nMerged answer [1]" }] }, finishReason: "STOP" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const result = await withTriEnv(() =>
    synthesizeFromPapers({
      userQuery: "测试材料性能",
      papers: [
        {
          title: "Test paper",
          doi: "10.1000/test",
          authors: ["A"],
          summary: "The material reached 24.5% efficiency.",
          source: "openalex",
        },
      ],
    }),
  );

  assert.equal(result.note, "synth:tri_arbitration_ok");
  assert.match(result.markdown, /Merged answer/);
  assert.deepEqual(result.synthesisModels, {
    modelA: "model-a",
    modelB: "model-b",
    modelC: "gemini-2.5-flash",
    mode: "tri_arbitration",
  });
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [
      "https://a.example/v1/chat/completions",
      "https://b.example/v1/chat/completions",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    ].sort(),
  );
  const geminiCall = calls.find((call) => String(call.url).includes("generativelanguage"));
  assert.equal(geminiCall.options.headers["x-goog-api-key"], "key-c");
  assert.equal(geminiCall.options.headers.Authorization, undefined);
  assert.equal(JSON.stringify(result).includes("key-a"), false);
  assert.equal(JSON.stringify(result).includes("key-b"), false);
  assert.equal(JSON.stringify(result).includes("key-c"), false);
});
