import assert from "node:assert/strict";
import test from "node:test";

import {
  LLM_PROTOCOLS,
  describeProvider,
  geminiGenerateContentUrl,
  openAiChatCompletionsUrl,
  resolvePrimaryProvider,
  resolveTriProviders,
} from "../llmProviders.js";

const ENV_NAMES = [
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "DASHSCOPE_API_KEY",
  "LLM_CHAT_COMPLETIONS_URL",
  "OPENAI_CHAT_COMPLETIONS_URL",
  "LLM_MODEL",
  "LLM_MODEL_B",
  "LLM_MODEL_C",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_API_KEY",
  ...["A", "B", "C"].flatMap((slot) => [
    `LLM_PROVIDER_${slot}_PROTOCOL`,
    `LLM_PROVIDER_${slot}_API_KEY`,
    `LLM_PROVIDER_${slot}_BASE_URL`,
    `LLM_PROVIDER_${slot}_MODEL`,
    `SYNTHESIS_API_KEY_${slot}`,
    `SYNTHESIS_CHAT_URL_${slot}`,
    `SYNTHESIS_MODEL_${slot}`,
  ]),
];

function withEnv(values, fn) {
  const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("primary provider keeps server credentials atomic", () => {
  withEnv(
    {
      LLM_API_KEY: "server-key",
      LLM_CHAT_COMPLETIONS_URL: "https://server.example/v1",
      LLM_MODEL: "server-model",
    },
    () => {
      const provider = resolvePrimaryProvider({ chatCompletionsUrl: "https://attacker.example/v1" });
      assert.equal(provider.apiKey, "server-key");
      assert.equal(provider.baseUrl, "https://server.example/v1");
      assert.equal(provider.model, "server-model");

      const client = resolvePrimaryProvider({
        apiKey: "client-key",
        chatCompletionsUrl: "https://client.example/v1/chat/completions",
        model: "client-model",
      });
      assert.equal(client.apiKey, "client-key");
      assert.equal(openAiChatCompletionsUrl(client), "https://client.example/v1/chat/completions");
      assert.equal(client.model, "client-model");
    },
  );
});

test("A and B are OpenAI-compatible while C uses native Gemini", () => {
  withEnv(
    {
      LLM_PROVIDER_A_PROTOCOL: "gemini",
      LLM_PROVIDER_A_API_KEY: "key-a",
      LLM_PROVIDER_A_BASE_URL: "https://a.example/v1",
      LLM_PROVIDER_A_MODEL: "model-a",
      LLM_PROVIDER_B_API_KEY: "key-b",
      LLM_PROVIDER_B_BASE_URL: "https://b.example/v1",
      LLM_PROVIDER_B_MODEL: "model-b",
      LLM_PROVIDER_C_PROTOCOL: "openai",
      LLM_PROVIDER_C_API_KEY: "key-c",
      LLM_PROVIDER_C_BASE_URL: "https://c.example/gemini/v1beta",
      LLM_PROVIDER_C_MODEL: "gemini-3.5-flash",
    },
    () => {
      const providers = resolveTriProviders();
      assert.ok(providers);
      assert.equal(providers.A.protocol, LLM_PROTOCOLS.OPENAI);
      assert.equal(providers.B.protocol, LLM_PROTOCOLS.OPENAI);
      assert.equal(providers.C.protocol, LLM_PROTOCOLS.GEMINI);
      assert.equal(openAiChatCompletionsUrl(providers.A), "https://a.example/v1/chat/completions");
      assert.equal(openAiChatCompletionsUrl(providers.B), "https://b.example/v1/chat/completions");
      assert.equal(
        geminiGenerateContentUrl(providers.C),
        "https://c.example/gemini/v1beta/models/gemini-3.5-flash:generateContent",
      );
      assert.equal("apiKey" in describeProvider(providers.C), false);
      assert.equal(Object.isFrozen(providers.A), true);
      assert.equal(Object.isFrozen(providers), true);
    },
  );
});

test("legacy C configuration uses native Gemini aliases with explicit precedence", () => {
  withEnv(
    {
      LLM_API_KEY: "primary-key",
      LLM_CHAT_COMPLETIONS_URL: "https://primary.example/v1",
      LLM_MODEL: "openai-model",
      SYNTHESIS_API_KEY_A: "key-a",
      SYNTHESIS_API_KEY_B: "key-b",
      SYNTHESIS_API_KEY_C: "preferred-key-c",
      GEMINI_API_KEY: "fallback-key-c",
      SYNTHESIS_CHAT_URL_A: "https://a.example/v1",
      SYNTHESIS_CHAT_URL_B: "https://b.example/v1",
      SYNTHESIS_CHAT_URL_C: "https://ignored.example/v1",
      GEMINI_BASE_URL: "https://preferred.example/gemini/v1beta",
      GOOGLE_GEMINI_BASE_URL: "https://fallback.example/gemini/v1beta",
      SYNTHESIS_MODEL_A: "model-a",
      SYNTHESIS_MODEL_B: "model-b",
      SYNTHESIS_MODEL_C: "gemini-preferred",
      LLM_MODEL_C: "gemini-fallback",
    },
    () => {
      const providers = resolveTriProviders();
      assert.ok(providers);
      assert.equal(providers.C.protocol, LLM_PROTOCOLS.GEMINI);
      assert.equal(providers.C.apiKey, "preferred-key-c");
      assert.equal(providers.C.model, "gemini-preferred");
      assert.equal(providers.C.baseUrl, "https://preferred.example/gemini/v1beta");
    },
  );
});

test("legacy C accepts Gemini CLI aliases and defaults to Google v1beta", () => {
  withEnv(
    {
      LLM_API_KEY: "primary-key",
      LLM_CHAT_COMPLETIONS_URL: "https://primary.example/v1",
      LLM_MODEL: "openai-model",
      SYNTHESIS_API_KEY_A: "key-a",
      SYNTHESIS_API_KEY_B: "key-b",
      SYNTHESIS_CHAT_URL_A: "https://a.example/v1",
      SYNTHESIS_CHAT_URL_B: "https://b.example/v1",
      SYNTHESIS_MODEL_A: "model-a",
      SYNTHESIS_MODEL_B: "model-b",
      GEMINI_API_KEY: "gemini-key",
      LLM_MODEL_C: "gemini-3-pro-preview",
    },
    () => {
      const providers = resolveTriProviders();
      assert.ok(providers);
      assert.equal(providers.C.apiKey, "gemini-key");
      assert.equal(providers.C.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
      assert.equal(providers.C.model, "gemini-3-pro-preview");
    },
  );

  withEnv(
    {
      LLM_API_KEY: "primary-key",
      LLM_MODEL: "openai-model",
      SYNTHESIS_API_KEY_A: "key-a",
      SYNTHESIS_API_KEY_B: "key-b",
      SYNTHESIS_MODEL_A: "model-a",
      SYNTHESIS_MODEL_B: "model-b",
      GEMINI_API_KEY: "gemini-key",
      GOOGLE_GEMINI_BASE_URL: "https://code.newcli.com/gemini",
      LLM_MODEL_C: "gemini-3-pro-preview",
    },
    () => {
      const providers = resolveTriProviders();
      assert.ok(providers);
      assert.equal(providers.C.baseUrl, "https://code.newcli.com/gemini");
      assert.equal(
        geminiGenerateContentUrl(providers.C),
        "https://code.newcli.com/gemini/models/gemini-3-pro-preview:generateContent",
      );
    },
  );
});

test("incomplete canonical provider slot does not mix with legacy fields", () => {
  withEnv(
    {
      LLM_PROVIDER_A_API_KEY: "canonical-key-only",
      SYNTHESIS_API_KEY_A: "legacy-key",
      SYNTHESIS_MODEL_A: "legacy-model",
      LLM_API_KEY: "primary-key",
      LLM_CHAT_COMPLETIONS_URL: "https://primary.example/v1",
      LLM_MODEL: "primary-model",
    },
    () => {
      assert.equal(resolveTriProviders(), null);
    },
  );

  withEnv(
    {
      LLM_PROVIDER_C_API_KEY: "canonical-key",
      LLM_PROVIDER_C_MODEL: "gemini-canonical",
      GEMINI_API_KEY: "legacy-key",
      GOOGLE_GEMINI_BASE_URL: "https://legacy.example/gemini",
      LLM_MODEL_C: "gemini-legacy",
      GOOGLE_API_KEY: "unrelated-google-key",
    },
    () => {
      assert.equal(resolveTriProviders(), null);
    },
  );
});

test("legacy C does not inherit broad Google or primary OpenAI configuration", () => {
  withEnv(
    {
      LLM_API_KEY: "primary-key",
      LLM_CHAT_COMPLETIONS_URL: "https://primary.example/v1",
      LLM_MODEL: "openai-model",
      GOOGLE_API_KEY: "unrelated-google-key",
      SYNTHESIS_CHAT_URL_C: "https://ignored.example/v1",
    },
    () => {
      assert.equal(resolveTriProviders(), null);
    },
  );
});
