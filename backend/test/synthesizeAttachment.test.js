import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeFromAttachmentContext } from "../synthesizeAttachment.js";

const PROVIDER_ENV = ["A", "B", "C"].flatMap((slot) => [
  `LLM_PROVIDER_${slot}_API_KEY`,
  `LLM_PROVIDER_${slot}_BASE_URL`,
  `LLM_PROVIDER_${slot}_MODEL`,
]);

async function withTriProviderEnv(fn) {
  const names = [
    ...PROVIDER_ENV,
    "LLM_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "LLM_CHAT_COMPLETIONS_URL",
    "LLM_MODEL",
    "SYNTHESIS_TIMEOUT_MS",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const slot of ["A", "B", "C"]) {
    process.env[`LLM_PROVIDER_${slot}_API_KEY`] = `key-${slot}`;
    process.env[`LLM_PROVIDER_${slot}_BASE_URL`] = "https://models.example/v1";
    process.env[`LLM_PROVIDER_${slot}_MODEL`] = slot === "C" ? "gemini-merge" : `model-${slot}`;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("attachment synthesis returns both independent drafts for the comparison panel", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const requestUrl = String(url);
    const requestBody = JSON.parse(init.body);
    calls.push(requestUrl);
    if (requestUrl.includes("/models/gemini-merge:generateContent")) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Merged attachment answer" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const model = requestBody.model;
    return new Response(JSON.stringify({
      choices: [{ message: { content: `${model} independent draft` }, finish_reason: "stop" }],
      model,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const result = await withTriProviderEnv(() => synthesizeFromAttachmentContext({
    userQuery: "根据上传文件总结内容",
    attachmentContext: "表格内容。".repeat(100),
  }));

  assert.equal(result.synthesisModels.mode, "attachment_tri_merge");
  assert.match(result.webAnswerDrafts.modelA, /model-A independent draft/);
  assert.match(result.webAnswerDrafts.modelB, /model-B independent draft/);
  assert.equal(result.webAnswerDrafts.modelC, null);
  assert.equal(result.webAnswerDrafts.noteC, "attachment:merge_only");
  assert.equal(calls.length, 3);
});
