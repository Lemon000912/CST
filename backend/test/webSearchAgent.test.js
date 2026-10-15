import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  buildEntityCoverageQueries,
  extractRequestedWebEntities,
  planWebSearchQueries,
  shouldUseWebSearchAgent,
} from "../webSearchAgent.js";

const ENV_NAMES = [
  "WEB_AI_SEARCH_PLANNER",
  "WEB_AI_PLAN_TIMEOUT_MS",
  "LLM_PROVIDER_A_API_KEY",
  "LLM_PROVIDER_A_BASE_URL",
  "LLM_PROVIDER_A_MODEL",
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

test("recognizes multi-entity metric questions", () => {
  assert.equal(shouldUseWebSearchAgent("产品甲、产品乙、产品丙、产品丁的产能利用率是多少"), true);
  assert.equal(shouldUseWebSearchAgent("什么是产能利用率"), false);
});

test("extracts every listed product and creates year-metric coverage queries", () => {
  const question = "2023年产能利用率低于75%的14种化工品：纯苯、苯乙烯、丙烯腈、环氧氯丙烷，查询2026年利用率";
  assert.deepEqual(extractRequestedWebEntities(question), ["纯苯", "苯乙烯", "丙烯腈", "环氧氯丙烷"]);
  const queries = buildEntityCoverageQueries(question);
  assert.equal(queries.length, 8);
  assert.deepEqual(queries.slice(0, 4), [
    "site:oilchem.net 纯苯 产能利用率 2026年",
    "site:sci99.com 苯乙烯 产能利用率 2026年",
    "site:mysteel.com 丙烯腈 产能利用率 2026年",
    "site:10jqka.com.cn 环氧氯丙烷 产能利用率 2026年",
  ]);
  assert.ok(queries.slice(4).some((query) => query.includes("隆众资讯")));
});

test("uses the configured model to plan bounded queries", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: "```json\n{\"queries\":[\"产品甲 产能利用率 2025\",\"产品乙 产能利用率 2025\",\"产品丙 产能利用率\"]}\n```",
          },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const queries = await withEnv({
      WEB_AI_SEARCH_PLANNER: "1",
      LLM_PROVIDER_A_API_KEY: "test-key",
      LLM_PROVIDER_A_BASE_URL: baseUrl,
      LLM_PROVIDER_A_MODEL: "test-model",
    }, () => planWebSearchQueries({
      userQuery: "产品甲、产品乙、产品丙、产品丁的产能利用率是多少",
      maxQueries: 2,
      effectiveQuery: "product capacity utilization",
    }));
    assert.deepEqual(queries, [
      "产品甲 产能利用率 2025",
      "产品乙 产能利用率 2025",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("can be disabled without calling the model", async () => {
  const queries = await withEnv({ WEB_AI_SEARCH_PLANNER: "0" }, () =>
    planWebSearchQueries({
      userQuery: "产品甲、产品乙、产品丙、产品丁的产能利用率是多少",
      maxQueries: 4,
    }),
  );
  assert.deepEqual(queries, []);
});
