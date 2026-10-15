import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { generateTextWithTools } from "../llmClientWithTools.js";

test("forceWebSearch pins the first tool call to web_search", async () => {
  let receivedChoice;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      receivedChoice = JSON.parse(body).tool_choice;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const result = await generateTextWithTools({
      protocol: "openai_chat_completions",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}/chat/completions`,
      model: "test-model",
    }, {
      messages: [{ role: "user", content: "find current data" }],
      enableWebSearch: true,
      forceWebSearch: true,
      maxToolIterations: 1,
    });

    assert.deepEqual(receivedChoice, {
      type: "function",
      function: { name: "web_search" },
    });
    assert.equal(result.text, "done");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("optional web search leaves the first tool choice to the model", async () => {
  let receivedChoice;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      receivedChoice = JSON.parse(body).tool_choice;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await generateTextWithTools({
      protocol: "openai_chat_completions",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}/chat/completions`,
      model: "test-model",
    }, {
      messages: [{ role: "user", content: "Use existing evidence if sufficient" }],
      enableWebSearch: true,
      forceWebSearch: false,
      maxToolIterations: 1,
    });

    assert.equal(receivedChoice, "auto");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
