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
  "WEB_STREAM_SPECULATIVE",
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

const completeAnswer = (prefix) =>
  `${prefix}\n\n## 核心结论\n\nAlpha 材料具有可测量的强度，并适用于多种工业应用场景。[1]\n\n` +
  "## 性能与应用\n\n- 现有网页摘录支持其强度可量化这一结论。[1]\n" +
  "- 具体指标和适用条件仍应结合来源原文进一步核验。[1]\n\n" +
  "## 关键数据与指标\n\n摘录未给出可核对数值。";

async function withMockLlm(fn) {
  const calls = [];
  const events = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const modelMatch = String(req.url ?? "").match(/\/models\/([^:]+):(?:streamGenerateContent|generateContent)/);
      const model = String(body.model ?? (modelMatch ? decodeURIComponent(modelMatch[1]) : "unknown"));
      const call = { model, url: req.url, body };
      calls.push(call);
      events.push(`start:${model}`);
      res.setHeader("Content-Type", "application/json");

      const finish = (status, payload) => {
        res.statusCode = status;
        events.push(`end:${model}`);
        res.end(JSON.stringify(payload));
      };
      const respond = () => {
        if (model === "qwen-reset" && calls.filter((item) => item.model === model).length === 1) {
          events.push(`end:${model}:reset`);
          req.socket.destroy();
          return;
        }
        if (model === "qwen-fail") {
          finish(503, { error: { message: "temporary failure" } });
          return;
        }
        if (model === "gemini-invalid") {
          finish(400, {
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "mock detail that must not reach the UI note",
            },
          });
          return;
        }
        if (model === "gemini-fragment") {
          finish(200, {
            candidates: [{ content: { parts: [{ text: ": > 2 TWh/year - LFP cycle life: 3000-5000 cycles" }] } }],
            modelVersion: model,
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          });
          return;
        }
        if (model.startsWith("gemini")) {
          finish(200, {
            candidates: [{ content: { parts: [{ text: completeAnswer(`Gemini arbitration ${calls.length}`) }] } }],
            modelVersion: model,
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 2,
              totalTokenCount: 17,
            },
          });
          return;
        }
        finish(200, {
          choices: [{ message: { content: completeAnswer(`${model} answer ${calls.length}`) }, finish_reason: "stop" }],
          model,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      };

      if (model.endsWith("-delay")) setTimeout(respond, 40);
      else respond();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    return await fn({ baseUrl, calls, events });
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
    WEB_TRI_CONCURRENCY: "2",
    WEB_STREAM_SPECULATIVE: "1",
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

async function runWebAnswer() {
  return synthesizeWebTriAnswer({
    userQuery: "Alpha material performance",
    papers: papers(),
  });
}

async function runStreamingWebAnswer(onTextDelta) {
  return synthesizeWebTriAnswer({
    userQuery: "Alpha material performance",
    papers: papers(),
    onTextDelta,
  });
}

test("web tri runs two drafts then C arbitration", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    await withEnv(providerEnv(baseUrl), async () => {
      const result = await runWebAnswer();
      assert.deepEqual(calls.slice(0, 2).map((call) => call.model).sort(), ["gpt-test", "qwen-test"]);
      assert.equal(calls[2].model, "gemini-test");
      assert.equal(calls.length, 3);
      const arbitrationPrompt = JSON.stringify(calls[2].body);
      assert.match(arbitrationPrompt, /模型 A 回答/);
      assert.match(arbitrationPrompt, /模型 B 回答/);
      assert.doesNotMatch(arbitrationPrompt, /--- 模型 C 回答 ---/);
      assert.match(arbitrationPrompt, /gpt-test answer/);
      assert.match(arbitrationPrompt, /qwen-test answer/);
      assert.match(result.markdown, /Gemini arbitration/);
      assert.match(result.webAnswerDrafts.modelA, /gpt-test answer/);
      assert.match(result.webAnswerDrafts.modelB, /qwen-test answer/);
      assert.equal(result.webAnswerDrafts.modelC, null);
      assert.equal(result.webAnswerDrafts.noteC, "web_answer:not_run_arbiter_only");
      assert.equal(result.synthesisModels.modelC, "gemini-test");
      assert.equal(result.synthesisModels.mode, "web_tri_arbitration");
      assert.deepEqual(result.llmUsage.slots.C, {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 17,
      });
      assert.equal(result.llmUsage.slots.merge, undefined);
      assert.equal(result.llmUsage.total.totalTokens, 47);
    });
  });
});

test("streaming web tri starts speculative C before A/B finish, then returns arbitrated final text", async () => {
  await withMockLlm(async ({ baseUrl, calls, events }) => {
    const env = providerEnv(baseUrl);
    env.LLM_PROVIDER_A_MODEL = "gpt-delay";
    env.LLM_PROVIDER_B_MODEL = "qwen-delay";
    await withEnv(env, async () => {
      const deltas = [];
      const result = await runStreamingWebAnswer((delta) => {
        deltas.push(delta);
        events.push("delta:preview");
      });

      assert.equal(calls.filter((call) => call.model === "gemini-test").length, 2);
      const previewCall = calls.find((call) =>
        call.model === "gemini-test" && !JSON.stringify(call.body).includes("模型 A 回答"),
      );
      const arbitrationCall = calls.find((call) =>
        call.model === "gemini-test" && JSON.stringify(call.body).includes("模型 A 回答"),
      );
      assert.ok(previewCall);
      assert.ok(arbitrationCall);
      assert.ok(events.indexOf("start:gemini-test") < events.indexOf("end:gpt-delay"), events.join(","));
      const firstPreviewDelta = events.indexOf("delta:preview");
      assert.ok(firstPreviewDelta >= 0, events.join(","));
      assert.ok(firstPreviewDelta < events.indexOf("end:qwen-delay"), events.join(","));
      assert.ok(deltas.join("").includes("Gemini arbitration"));
      assert.equal(result.synthesisModels.mode, "web_tri_speculative_arbitration");
      assert.match(result.markdown, /Gemini arbitration/);
      assert.ok(result.llmUsage.slots.preview);
      assert.ok(result.llmUsage.slots.C);
      assert.equal(result.llmUsage.total.totalTokens, 64);
    });
  });
});

test("web tri supports sequential, concurrent, and legacy concurrency values", async () => {
  for (const concurrency of ["1", "2", "3"]) {
    await withMockLlm(async ({ baseUrl, events }) => {
      const env = providerEnv(baseUrl);
      env.WEB_TRI_CONCURRENCY = concurrency;
      env.LLM_PROVIDER_A_MODEL = "gpt-delay";
      env.LLM_PROVIDER_B_MODEL = "qwen-delay";
      await withEnv(env, runWebAnswer);
      const startA = events.indexOf("start:gpt-delay");
      const endA = events.indexOf("end:gpt-delay");
      const startB = events.indexOf("start:qwen-delay");
      const endB = events.indexOf("end:qwen-delay");
      const startC = events.indexOf("start:gemini-test");
      if (concurrency === "1") assert.ok(endA < startB, events.join(","));
      else assert.ok(startA < endB && startB < endA, events.join(","));
      assert.ok(startC > endA && startC > endB, events.join(","));
    });
  }
});

test("web tri skips C when one draft provider is missing", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    const env = providerEnv(baseUrl);
    delete env.LLM_PROVIDER_B_API_KEY;
    delete env.LLM_PROVIDER_B_BASE_URL;
    delete env.LLM_PROVIDER_B_MODEL;
    await withEnv(env, async () => {
      const result = await runWebAnswer();
      assert.deepEqual(calls.map((call) => call.model), ["gpt-test"]);
      assert.match(result.markdown, /gpt-test answer/);
      assert.equal(result.webAnswerDrafts.modelB, null);
      assert.equal(result.webAnswerDrafts.noteB, "web_answer:provider_not_configured");
      assert.equal(result.webAnswerDrafts.modelC, null);
      assert.match(result.synthesisModels.mode, /web_tri_partial_1_config_incomplete/);
    });
  });
});

test("web tri skips C when one configured draft fails", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    const env = providerEnv(baseUrl);
    env.LLM_PROVIDER_B_MODEL = "qwen-fail";
    await withEnv(env, async () => {
      const result = await runWebAnswer();
      assert.deepEqual(calls.map((call) => call.model).sort(), ["gpt-test", "qwen-fail"]);
      assert.match(result.markdown, /gpt-test answer/);
      assert.equal(result.webAnswerDrafts.noteB, "web_answer:http_503");
      assert.equal(result.synthesisModels.mode, "web_tri_partial_1");
    });
  });
});

test("web tri retries a transient fetch failure before giving up a draft", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    const env = providerEnv(baseUrl);
    env.WEB_ANSWER_RETRIES = "2";
    env.LLM_PROVIDER_B_MODEL = "qwen-reset";
    await withEnv(env, async () => {
      const result = await runWebAnswer();
      assert.equal(calls.filter((call) => call.model === "qwen-reset").length, 2);
      assert.match(result.webAnswerDrafts.modelB, /qwen-reset answer/);
      assert.equal(result.webAnswerDrafts.noteB, "web_answer:ok_retry_2");
      assert.equal(result.synthesisModels.mode, "web_tri_arbitration");
    });
  });
});

test("web tri rejects a fragmented C arbitration and falls back to a draft", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    const env = providerEnv(baseUrl);
    env.LLM_PROVIDER_C_MODEL = "gemini-fragment";
    await withEnv(env, async () => {
      const result = await runWebAnswer();
      assert.equal(calls.filter((call) => call.model === "gemini-fragment").length, 1);
      assert.match(result.markdown, /(gpt-test|qwen-test) answer/);
      assert.equal(result.webAnswerDrafts.modelC, null);
      assert.equal(result.llmUsage.slots.C.totalTokens, 7);
      assert.equal(result.synthesisModels.mode, "web_tri_fallback_longest");
      assert.match(result.note, /web_arbitration:too_short/);
    });
  });
});

test("web tri exposes safe C arbitration error status", async () => {
  await withMockLlm(async ({ baseUrl, calls }) => {
    const env = providerEnv(baseUrl);
    env.LLM_PROVIDER_C_MODEL = "gemini-invalid";
    await withEnv(env, async () => {
      const result = await runWebAnswer();
      // A and B drafts run in parallel; order non-deterministic. Third call is C arbiter.
      const draftModels = calls.slice(0, 2).map((call) => call.model).sort();
      assert.deepEqual(draftModels, ["gpt-test", "qwen-test"]);
      assert.equal(calls[2].model, "gemini-invalid");
      assert.equal(result.webAnswerDrafts.noteC, "web_answer:not_run_arbiter_only");
      assert.match(result.note, /web_arbitration:http_400:INVALID_ARGUMENT/);
      assert.equal(result.note.includes("mock detail"), false);
      assert.equal(JSON.stringify(result).includes("key-c"), false);
      assert.equal(result.synthesisModels.mode, "web_tri_fallback_longest");
    });
  });
});

test("web tri keeps compatible empty draft slots when no relevant sources exist", async () => {
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
