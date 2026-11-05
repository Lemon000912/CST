import test from "node:test";
import assert from "node:assert/strict";
import { planEpsSearch } from "../epsQueryPlan.js";
test("EPS计划只接受英文检索词和完整IPC分类号，不接受模型编造的专利链接", async () => {
  const names = ["LLM_PROVIDER_B_API_KEY", "LLM_PROVIDER_B_BASE_URL", "LLM_PROVIDER_B_MODEL", "LLM_PROVIDER_B_PROTOCOL"];
  const before = names.map(n => process.env[n]); const original = globalThis.fetch;
  Object.assign(process.env, { LLM_PROVIDER_B_API_KEY: "test", LLM_PROVIDER_B_BASE_URL: "https://plan.test/v1", LLM_PROVIDER_B_MODEL: "fast-test", LLM_PROVIDER_B_PROTOCOL: "openai_chat_completions" });
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ queries: ["cable corrosion detection", "https://patents.google.com/patent/CN123A", "EP0816797B1"], ipcCodes: ["G01N 17/00", "G01N17/00", "invalid", "EP0816797B1"] }) } }] });
  try {
    const r = await planEpsSearch("地下电缆腐蚀怎么测量");
    assert.deepEqual(r.queries, ["site:data.epo.org/publication-server cable corrosion detection"]);
    assert.deepEqual(r.ipcCodes, ["G01N17/00"]);
  } finally { globalThis.fetch = original; names.forEach((n, i) => before[i] === undefined ? delete process.env[n] : process.env[n] = before[i]); }
});
