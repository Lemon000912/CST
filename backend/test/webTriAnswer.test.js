import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { synthesizeWebTriAnswer } from "../webTriAnswer.js";

const ENV_NAMES = [
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
  "LLM_CHAT_COMPLETIONS_URL",
  "OPENAI_CHAT_COMPLETIONS_URL",
  "LLM_MODEL",
  "WEB_TRI_MODE",
  "WEB_TRI_CONCURRENCY",
  "WEB_ANSWER_RETRIES",
  "SYNTHESIS_TIMEOUT_MS",
  ...["A", "B", "C"].flatMap((slot) => [
    `LLM_PROVIDER_${slot}_API_KEY`,
    `LLM_PROVIDER_${slot}_BASE_URL`,
    `LLM_PROVIDER_${slot}_MODEL`,
    `SYNTHESIS_API_KEY_${slot}`,
    `SYNTHESIS_CHAT_URL_${slot}`,
    `SYNTHESIS_MODEL_${slot}`,
  ]),
];

async function withEnv(values, fn) {
  const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withMockLlm(fn) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const modelMatch = String(req.url ?? "").match(/\/models\/([^:]+):generateContent/);
      const model = String(body.model ?? (modelMatch ? decodeURIComponent(modelMatch[1]) : "unknown"));
      calls.push({ model, url: req.url });
      res.setHeader("Content-Type", "application/json");
      if (model === "qwen-fail") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: "temporary failure" } }));
        return;
      }
      if (model.startsWith("gemini")) {
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: `Gemini answer ${calls.length}` }] } }],
          modelVersion: model,
        }));
        return;
      }
      res.end(JSON.stringify({
        choices: [{ message: { content: `${model} answer ${calls.length}` }, finish_reason: "stop" }],
        model,
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    return await fn({ baseUrl, calls });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function papers() {
  return [{
    source: "ddg_web",
    title: "Alpha material performance",
    summary: "Alpha material has measurable strength and useful industrial applications.",
    absUrl: "https://example.com/alpha",
  }];
}

function providerEnv(baseUrl) {
  return {
    WEB_TRI_MODE: "tri",
    WEB_TRI_CONCURRENCY: "1",
    WEB_ANSWER_RETRIES: "1",
    SYNTHESIS_TIMEOUT_MS: "5000",
    LLM_PROVIDER_A_API_KEY: "key-a",
    LLM_PROVIDER_A_BASE_URL: baseUrl,
    LLM_PROVIDER_A_MODEL: "gpt-test",
    LLM_PROVIDER_B_API_KEY: "key-b",
    LLM_PROVIDER_B_BASE_URL: baseUrl,
    LLM_PROVIDER_B_MODEL: "qwen-test",
    LLM_PROVIDER_C_API_KEY: "key-c",
    LLM_PROVIDER_C_BASE_URL: baseUrl,
    LLM_PROVIDER_C_MODEL: "gemini-test",
  };
}

test("web tri calls GPT, Qwen, and Gemini and returns all drafts", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    await withEnv(providerEnv(baseUrl), async () => {
      const result = await synthesizeWebTriAnswer({
        userQuery: "Alpha material performance",
        papers: papers(),
      });
      assert.deepEqual(calls.slice(0, 3).map((call) => call.model), ["gpt-test", "qwen-test", "gemini-test"]);
      assert.equal(calls.length, 4);
      assert.match(result.webAnswerDrafts.modelA, /gpt-test answer/);
      assert.match(result.webAnswerDrafts.modelB, /qwen-test answer/);
      assert.match(result.webAnswerDrafts.modelC, /Gemini answer/);
      assert.equal(result.synthesisModels.mode, "web_tri_arbitration");
    });
  });
});

test("web tri still calls configured slots when Qwen provider is missing", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    const env = providerEnv(baseUrl);
    delete env.LLM_PROVIDER_B_API_KEY;
    delete env.LLM_PROVIDER_B_BASE_URL;
    delete env.LLM_PROVIDER_B_MODEL;
    await withEnv(env, async () => {
      const result = await synthesizeWebTriAnswer({
        userQuery: "Alpha material performance",
        papers: papers(),
      });
      assert.deepEqual(calls.slice(0, 2).map((call) => call.model), ["gpt-test", "gemini-test"]);
      assert.equal(calls.length, 3);
      assert.match(result.webAnswerDrafts.modelA, /gpt-test answer/);
      assert.equal(result.webAnswerDrafts.modelB, null);
      assert.equal(result.webAnswerDrafts.noteB, "web_answer:provider_not_configured");
      assert.match(result.webAnswerDrafts.modelC, /Gemini answer/);
      assert.match(result.synthesisModels.mode, /config_incomplete/);
    });
  });
});

test("web tri keeps Qwen failure visible while GPT and Gemini succeed", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    const env = providerEnv(baseUrl);
    env.LLM_PROVIDER_B_MODEL = "qwen-fail";
    await withEnv(env, async () => {
      const result = await synthesizeWebTriAnswer({
        userQuery: "Alpha material performance",
        papers: papers(),
      });
      assert.deepEqual(calls.slice(0, 3).map((call) => call.model), ["gpt-test", "qwen-fail", "gemini-test"]);
      assert.match(result.webAnswerDrafts.modelA, /gpt-test answer/);
      assert.equal(result.webAnswerDrafts.modelB, null);
      assert.equal(result.webAnswerDrafts.noteB, "web_answer:http_503");
      assert.match(result.webAnswerDrafts.modelC, /Gemini answer/);
      assert.equal(result.synthesisModels.mode, "web_tri_merge_2of3");
    });
  });
});

test("web tri keeps three failure slots when no relevant sources exist", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    await withEnv(providerEnv(baseUrl), async () => {
      const result = await synthesizeWebTriAnswer({
        userQuery: "Alpha material performance",
        papers: [],
      });
      assert.equal(calls.length, 0);
      assert.equal(result.synthesisModels.mode, "web_tri_no_sources");
      assert.deepEqual(
        [result.webAnswerDrafts.modelA, result.webAnswerDrafts.modelB, result.webAnswerDrafts.modelC],
        [null, null, null],
      );
      assert.match(result.webAnswerDrafts.noteB, /not_run_no_relevant_sources/);
    });
  });
});
