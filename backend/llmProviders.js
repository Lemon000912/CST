const OPENAI_PROTOCOL = "openai_chat_completions";
const GEMINI_PROTOCOL = "gemini_generate_content";
const DEFAULT_OPENAI_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export const LLM_PROTOCOLS = Object.freeze({
  OPENAI: OPENAI_PROTOCOL,
  GEMINI: GEMINI_PROTOCOL,
});

export function safeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function defaultModel() {
  const model = String(
    process.env.LLM_MODEL ??
      process.env.DEEPSEEK_MODEL ??
      process.env.DASHSCOPE_MODEL ??
      process.env.OPENAI_MODEL ??
      "",
  ).trim();
  return model || "deepseek-v4-flash";
}

export function sanitizeModel(value, fallback = defaultModel()) {
  const model = String(value ?? "").trim();
  if (!model || model.startsWith("sk-") || model.length > 128) return fallback;
  if (!/^[a-zA-Z0-9._/-]+$/.test(model)) return fallback;
  return model;
}

function normalizeProtocol(value, model) {
  const protocol = String(value ?? "").trim().toLowerCase();
  if (protocol === GEMINI_PROTOCOL || protocol === "gemini" || protocol === "google") {
    return GEMINI_PROTOCOL;
  }
  if (protocol === OPENAI_PROTOCOL || protocol === "openai" || protocol === "chat_completions") {
    return OPENAI_PROTOCOL;
  }
  return /^gemini(?:[-/]|$)/i.test(String(model ?? "")) ? GEMINI_PROTOCOL : OPENAI_PROTOCOL;
}

function protocolForSlot(slot) {
  const id = String(slot).toUpperCase();
  return id === "C" ? GEMINI_PROTOCOL : OPENAI_PROTOCOL;
}

function makeProvider({ slot, protocol, apiKey, baseUrl, model, source }) {
  const normalizedModel = sanitizeModel(model, "");
  const normalizedProtocol = normalizeProtocol(protocol, normalizedModel);
  const normalizedKey = String(apiKey ?? "").trim();
  const normalizedBase = safeHttpUrl(baseUrl);
  if (!normalizedKey || !normalizedBase || !normalizedModel) return null;
  return Object.freeze({
    slot,
    protocol: normalizedProtocol,
    apiKey: normalizedKey,
    baseUrl: normalizedBase,
    model: normalizedModel,
    source,
  });
}

function envFirst(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function canonicalProvider(slot) {
  const id = String(slot ?? "").trim().toUpperCase();
  const prefix = `LLM_PROVIDER_${id}`;
  const present = ["API_KEY", "BASE_URL", "MODEL"].some((field) =>
    String(process.env[`${prefix}_${field}`] ?? "").trim(),
  );
  if (!present) return { present: false, provider: null };
  return {
    present: true,
    provider: makeProvider({
      slot: id,
      protocol: protocolForSlot(id),
      apiKey: process.env[`${prefix}_API_KEY`],
      baseUrl: process.env[`${prefix}_BASE_URL`],
      model: process.env[`${prefix}_MODEL`],
      source: "provider",
    }),
  };
}

export function resolvePrimaryProvider(hints = {}) {
  const canonicalA = canonicalProvider("A");
  if (canonicalA.present) return canonicalA.provider;

  const clientKey = String(hints.apiKey ?? "").trim();
  const clientUrl = safeHttpUrl(hints.chatCompletionsUrl ?? hints.baseUrl);
  const clientModel = sanitizeModel(hints.model, "");
  if (clientKey) {
    return makeProvider({
      slot: "primary",
      protocol: OPENAI_PROTOCOL,
      apiKey: clientKey,
      baseUrl:
        clientUrl ||
        envFirst("LLM_CHAT_COMPLETIONS_URL", "OPENAI_CHAT_COMPLETIONS_URL") ||
        DEFAULT_OPENAI_BASE_URL,
      model: clientModel || defaultModel(),
      source: "client",
    });
  }

  return makeProvider({
    slot: "primary",
    protocol: OPENAI_PROTOCOL,
    apiKey: envFirst("LLM_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY"),
    baseUrl:
      envFirst("LLM_CHAT_COMPLETIONS_URL", "OPENAI_CHAT_COMPLETIONS_URL") ||
      DEFAULT_OPENAI_BASE_URL,
    model: defaultModel(),
    source: "environment",
  });
}

export function resolveProviderSlot(slot, hints = {}) {
  const id = String(slot ?? "").trim().toUpperCase();
  if (!/^[ABC]$/.test(id)) return null;

  const canonical = canonicalProvider(id);
  if (canonical.present) return canonical.provider;

  if (id === "C") {
    return makeProvider({
      slot: id,
      protocol: GEMINI_PROTOCOL,
      apiKey: envFirst("SYNTHESIS_API_KEY_C", "GEMINI_API_KEY"),
      baseUrl:
        envFirst("GEMINI_BASE_URL", "GOOGLE_GEMINI_BASE_URL") || DEFAULT_GEMINI_BASE_URL,
      model: envFirst("SYNTHESIS_MODEL_C", "LLM_MODEL_C"),
      source: "synthesis-legacy",
    });
  }

  const primary = resolvePrimaryProvider();
  const modelFallback =
    id === "A"
      ? primary?.model || defaultModel()
      : process.env.LLM_MODEL_B || primary?.model || defaultModel();
  const model = envFirst(`SYNTHESIS_MODEL_${id}`) || modelFallback;
  const protocol = protocolForSlot(id);
  const baseUrl = envFirst(`SYNTHESIS_CHAT_URL_${id}`) || primary?.baseUrl;
  return makeProvider({
    slot: id,
    protocol,
    apiKey: envFirst(`SYNTHESIS_API_KEY_${id}`),
    baseUrl,
    model,
    source: "synthesis-legacy",
  });
}

export function resolveTriProviders(hints = {}) {
  const A = resolveProviderSlot("A", hints);
  const B = resolveProviderSlot("B", hints);
  const C = resolveProviderSlot("C", hints);
  return A && B && C ? Object.freeze({ A, B, C }) : null;
}

export function withProviderModel(provider, model, slot = provider?.slot) {
  if (!provider) return null;
  return makeProvider({
    slot,
    protocol: provider.protocol,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: sanitizeModel(model, provider.model),
    source: provider.source,
  });
}

export function describeProvider(provider) {
  if (!provider) return null;
  return {
    slot: provider.slot,
    protocol: provider.protocol,
    model: provider.model,
    source: provider.source,
  };
}

export function openAiChatCompletionsUrl(provider) {
  const base = safeHttpUrl(provider?.baseUrl);
  if (!base) return "";
  // 如果用户已填完整端点地址则原样使用
  if (/\/chat\/completions$/i.test(base)) return base;
  // 否则自动补齐（中转站通常只填 /v1，尾部不带路径时才补充）
  if (/\/v\d+(\.\d+)?$/i.test(base)) return `${base}/chat/completions`;
  return `${base.replace(/\/$/, "")}/chat/completions`;
}

export function geminiGenerateContentUrl(provider) {
  const base = safeHttpUrl(provider?.baseUrl) || DEFAULT_GEMINI_BASE_URL;
  if (!base) return "";
  if (/:generateContent$/i.test(base)) return base;
  const model = encodeURIComponent(String(provider?.model ?? "").replace(/^models\//i, ""));
  return `${base.replace(/\/$/, "")}/models/${model}:generateContent`;
}
