import test from "node:test";
import assert from "node:assert/strict";
import { rewriteQueryForSearch } from "../rewrite.js";

async function withProviders(fn) {
  const values = { LLM_PROVIDER_A_API_KEY: "test-a", LLM_PROVIDER_A_BASE_URL: "https://a.test/v1", LLM_PROVIDER_A_MODEL: "thinking-test", LLM_PROVIDER_A_PROTOCOL: "openai_chat_completions", LLM_PROVIDER_B_API_KEY: "test-b", LLM_PROVIDER_B_BASE_URL: "https://b.test/v1", LLM_PROVIDER_B_MODEL: "fast-test", LLM_PROVIDER_B_PROTOCOL: "openai_chat_completions" };
  const before = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  const original = globalThis.fetch; Object.assign(process.env, values);
  try { await fn(); } finally { globalThis.fetch = original; for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
test("思考模型改写只有推理且达到长度上限时，B补全英文检索词", async () => {
  await withProviders(async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(String(url)); const request = JSON.parse(options.body);
      return Response.json({ choices: [{ finish_reason: calls.length === 1 ? "length" : "stop", message: calls.length === 1 ? { content: "", reasoning_content: "需要先分析中文语义，再逐项翻译技术词，正在思考" } : { content: "underground cable corrosion non contact measurement" } }] });
    };
    const r = await rewriteQueryForSearch("地下电线腐蚀状态如何非接触测量");
    assert.equal(r.note, "rewrite:secondary-keywords"); assert.match(r.effectiveQuery, /corrosion/);
    assert.deepEqual(calls, ["https://a.test/v1/chat/completions", "https://b.test/v1/chat/completions"]);
  });
});
test("显式用户Key改写失败时不会改用服务端B凭据", async () => {
  await withProviders(async () => {
    for (const key of ["LLM_PROVIDER_A_API_KEY", "LLM_PROVIDER_A_BASE_URL", "LLM_PROVIDER_A_MODEL", "LLM_PROVIDER_A_PROTOCOL"]) delete process.env[key];
    const calls = [];
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json({ choices: [{ message: { content: "", reasoning_content: "仅在推理" }, finish_reason: "length" }] }); };
    await rewriteQueryForSearch("地下电线腐蚀状态如何非接触测量", { apiKey: "caller-key", model: "caller-test", chatCompletionsUrl: "https://caller.test/v1/chat/completions" });
    assert.deepEqual(calls, ["https://caller.test/v1/chat/completions"]);
  });
});
