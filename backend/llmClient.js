import {
  LLM_PROTOCOLS,
  geminiGenerateContentUrl,
  openAiChatCompletionsUrl,
} from "./llmProviders.js";

/**
 * 流式文本生成（async generator）。
 * 逐 token yield 字符串片段；调用方可通过 for-await-of 消费。
 * Gemini 使用 streamGenerateContent；OpenAI 兼容接口使用 stream:true。
 *
 * @param {import("./llmProviders.js").Provider} provider
 * @param {object} request  与 generateText 参数完全一致
 * @yields {string}  每次 yield 一个非空 token 字符串
 */
export async function* generateTextStream(provider, request = {}) {
  if (!provider?.apiKey || !provider?.baseUrl || !provider?.model) return;

  const controller = new AbortController();
  const timeoutMs = Math.min(360_000, Math.max(1_000, Number(request.timeoutMs) || 120_000));
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = request.signal;
  const abort = () => controller.abort();
  externalSignal?.addEventListener?.("abort", abort, { once: true });

  try {
    const isGemini = provider.protocol === LLM_PROTOCOLS.GEMINI;
    const messages = request.messages || [];

    let url, body, headers;
    if (isGemini) {
      // Gemini: streamGenerateContent 端点
      const base = geminiGenerateContentUrl(provider);
      url = base.replace(/:generateContent$/, ":streamGenerateContent");
      body = geminiBody(request);
      headers = { "x-goog-api-key": provider.apiKey, "Content-Type": "application/json" };
    } else {
      url = openAiChatCompletionsUrl(provider);
      body = {
        model: provider.model,
        stream: true,
        ...(Number.isFinite(request.temperature) ? { temperature: request.temperature } : {}),
        ...(Number.isFinite(request.maxTokens) ? { max_tokens: Math.floor(request.maxTokens) } : {}),
        messages: request.system
          ? [{ role: "system", content: String(request.system) }, ...messages]
          : messages,
      };
      headers = { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" };
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // 非 2xx：不 yield，静默返回（调用方得不到任何 token）
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 按行切割 SSE
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 保留未完成的行
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            let token = "";
            if (isGemini) {
              // Gemini streamGenerateContent 返回多个 candidates 对象（非 SSE，而是 JSON Lines）
              const parts = json?.candidates?.[0]?.content?.parts;
              token = Array.isArray(parts)
                ? parts.map((p) => String(p?.text ?? "")).join("")
                : String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
            } else {
              // OpenAI-compatible: delta.content 或 delta.reasoning_content
              token = String(json?.choices?.[0]?.delta?.content ?? "");
            }
            if (token) yield token;
          } catch {
            // 跳过格式不合法的行
          }
        }
      }
    }
  } catch {
    // 超时 / 网络错误 / abort：停止 yield
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener?.("abort", abort);
  }
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => (typeof part === "string" ? part : String(part?.text ?? "")))
    .join("\n");
}

function geminiBody(request) {
  const systemParts = [];
  const contents = [];
  if (request.system) systemParts.push({ text: String(request.system) });
  for (const message of request.messages || []) {
    const role = String(message?.role ?? "user");
    const text = messageText(message?.content);
    if (!text) continue;
    if (role === "system") {
      systemParts.push({ text });
      continue;
    }
    contents.push({ role: role === "assistant" ? "model" : "user", parts: [{ text }] });
  }
  const generationConfig = {};
  if (Number.isFinite(request.temperature)) generationConfig.temperature = request.temperature;
  if (Number.isFinite(request.maxTokens)) {
    generationConfig.maxOutputTokens = Math.floor(request.maxTokens);
  }
  return {
    ...(systemParts.length ? { system_instruction: { parts: systemParts } } : {}),
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: " " }] }],
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

function geminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.thought !== true)
    .map((part) => String(part?.text ?? ""))
    .filter(Boolean)
    .join("")
    .trim();
}

function streamText(json, isGemini) {
  if (isGemini) {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((part) => part?.thought !== true)
      .map((part) => String(part?.text ?? ""))
      .join("");
  }
  const content = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : String(part?.text ?? "")))
    .join("");
}

function tokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined;
}

export function normalizeLlmUsage(json, protocol) {
  const isGemini = protocol === LLM_PROTOCOLS.GEMINI;
  const raw = isGemini ? json?.usageMetadata : json?.usage;
  if (!raw || typeof raw !== "object") return null;

  const inputTokens = tokenCount(isGemini ? raw.promptTokenCount : raw.prompt_tokens);
  const outputTokens = tokenCount(isGemini ? raw.candidatesTokenCount : raw.completion_tokens);
  const reasoningTokens = tokenCount(
    isGemini ? raw.thoughtsTokenCount : raw.completion_tokens_details?.reasoning_tokens,
  );
  const cachedInputTokens = tokenCount(
    isGemini ? raw.cachedContentTokenCount : raw.prompt_tokens_details?.cached_tokens,
  );
  const reportedTotal = tokenCount(isGemini ? raw.totalTokenCount : raw.total_tokens);
  const totalTokens = reportedTotal ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

async function generateTextStreamingResult(provider, request) {
  const controller = new AbortController();
  const timeoutMs = Math.min(360_000, Math.max(1_000, Number(request.timeoutMs) || 120_000));
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = request.signal;
  const abort = () => controller.abort();
  let emitted = false;
  externalSignal?.addEventListener?.("abort", abort, { once: true });

  try {
    const isGemini = provider.protocol === LLM_PROTOCOLS.GEMINI;
    const baseUrl = isGemini
      ? geminiGenerateContentUrl(provider).replace(/:generateContent$/, ":streamGenerateContent")
      : openAiChatCompletionsUrl(provider);
    const url = isGemini
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}alt=sse`
      : baseUrl;
    const messages = request.messages || [];
    const body = isGemini
      ? geminiBody(request)
      : {
          model: provider.model,
          stream: true,
          ...(request.omitStreamOptions ? {} : { stream_options: { include_usage: true } }),
          ...(Number.isFinite(request.temperature) ? { temperature: request.temperature } : {}),
          ...(Number.isFinite(request.maxTokens)
            ? { max_tokens: Math.floor(request.maxTokens) }
            : {}),
          messages: request.system
            ? [{ role: "system", content: String(request.system) }, ...messages]
            : messages,
        };
    const response = await fetch(url, {
      method: "POST",
      headers: isGemini
        ? { "x-goog-api-key": provider.apiKey, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const raw = await response.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch {}
      return {
        ok: false,
        status: response.status,
        text: "",
        error: `http_${response.status}`,
        errorBody: raw.slice(0, 500),
        usage: normalizeLlmUsage(json, provider.protocol),
        json,
        streamed: false,
        streamFallbackRecommended: [400, 404, 405, 415, 422].includes(response.status),
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        ok: false,
        status: response.status,
        text: "",
        error: "stream_body_unavailable",
        errorBody: "",
        streamed: false,
        streamFallbackRecommended: true,
      };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let usage = null;
    let finishReason;
    let responseModel = provider.model;
    const consumeLine = async (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]" || trimmed.startsWith(":")) return;
      const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trimStart() : trimmed;
      if (!payload || payload === "[DONE]") return;
      let json;
      try { json = JSON.parse(payload); } catch { return; }
      const delta = streamText(json, isGemini);
      if (delta) {
        text += delta;
        emitted = true;
        await request.onTextDelta(delta);
      }
      usage = normalizeLlmUsage(json, provider.protocol) || usage;
      finishReason = isGemini
        ? (json?.candidates?.[0]?.finishReason ?? finishReason)
        : (json?.choices?.[0]?.finish_reason ?? finishReason);
      responseModel = json?.modelVersion || json?.model || responseModel;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) await consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consumeLine(buffer);

    const normalizedText = text.trim();
    if (!normalizedText) {
      return {
        ok: false,
        status: response.status,
        text: "",
        error: "empty",
        errorBody: "",
        usage,
        streamed: emitted,
        streamFallbackRecommended: !emitted,
      };
    }
    return {
      ok: true,
      status: response.status,
      text: normalizedText,
      reasoningText: "",
      finishReason,
      responseModel,
      usage,
      streamed: emitted,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
      exception: error,
      errorBody: "",
      streamed: emitted,
      streamFallbackRecommended: !emitted,
    };
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener?.("abort", abort);
  }
}

export async function generateText(provider, request = {}) {
  if (!provider?.apiKey || !provider?.baseUrl || !provider?.model) {
    return {
      ok: false,
      status: 0,
      text: "",
      error: "provider_not_configured",
      errorBody: "",
    };
  }
  if (request.signal?.aborted) {
    return {
      ok: false,
      status: 0,
      text: "",
      error: "aborted",
      errorBody: "",
      streamed: false,
      streamFallbackRecommended: false,
    };
  }

  if (typeof request.onTextDelta === "function") {
    const streamed = await generateTextStreamingResult(provider, request);
    if (request.signal?.aborted) return streamed;
    if (streamed.ok || !streamed.streamFallbackRecommended) return streamed;
    // Some OpenAI-compatible gateways support SSE but reject stream_options.
    if (provider.protocol !== LLM_PROTOCOLS.GEMINI && !request.omitStreamOptions) {
      const compatibilityStream = await generateTextStreamingResult(provider, {
        ...request,
        omitStreamOptions: true,
      });
      if (compatibilityStream.ok || !compatibilityStream.streamFallbackRecommended) {
        return compatibilityStream;
      }
    }
    // Gateways without SSE retain the established non-streaming behavior.
    const {
      onTextDelta: _onTextDelta,
      omitStreamOptions: _omitStreamOptions,
      ...nonStreamingRequest
    } = request;
    return generateText(provider, nonStreamingRequest);
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(360_000, Math.max(1_000, Number(request.timeoutMs) || 120_000));
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = request.signal;
  const abort = () => controller.abort();
  externalSignal?.addEventListener?.("abort", abort, { once: true });

  try {
    const isGemini = provider.protocol === LLM_PROTOCOLS.GEMINI;
    const url = isGemini
      ? geminiGenerateContentUrl(provider)
      : openAiChatCompletionsUrl(provider);
    const messages = request.messages || [];
    const body = isGemini
      ? geminiBody(request)
      : {
          model: provider.model,
          ...(Number.isFinite(request.temperature) ? { temperature: request.temperature } : {}),
          ...(Number.isFinite(request.maxTokens)
            ? { max_tokens: Math.floor(request.maxTokens) }
            : {}),
          messages: request.system
            ? [{ role: "system", content: String(request.system) }, ...messages]
            : messages,
        };

    const response = await fetch(url, {
      method: "POST",
      headers: isGemini
        ? { "x-goog-api-key": provider.apiKey, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {}

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        text: "",
        error: `http_${response.status}`,
        errorBody: raw.slice(0, 500),
        usage: normalizeLlmUsage(json, provider.protocol),
        json,
      };
    }

    const text = isGemini
      ? geminiText(json)
      : String(json?.choices?.[0]?.message?.content ?? "").trim();
    const reasoningText = isGemini
      ? ""
      : String(json?.choices?.[0]?.message?.reasoning_content ?? "").trim();
    if (!text && !reasoningText) {
      const blockReason = String(
        json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason ?? "",
      );
      return {
        ok: false,
        status: response.status,
        text: "",
        reasoningText: "",
        error: blockReason ? `empty_${blockReason}` : "empty",
        errorBody: raw.slice(0, 500),
        usage: normalizeLlmUsage(json, provider.protocol),
        json,
      };
    }

    return {
      ok: true,
      status: response.status,
      text,
      reasoningText,
      finishReason: isGemini
        ? json?.candidates?.[0]?.finishReason
        : json?.choices?.[0]?.finish_reason,
      responseModel: json?.modelVersion || json?.model || provider.model,
      usage: normalizeLlmUsage(json, provider.protocol),
      json,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: "",
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
      exception: error,
      errorBody: "",
    };
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener?.("abort", abort);
  }
}
