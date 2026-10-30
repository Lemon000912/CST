import { createHmac, randomBytes, randomUUID } from "node:crypto";

// Process-local salt lets us compare identical inputs without logging them or
// producing a stable hash that could be used to guess a user's search terms.
const inputSalt = randomBytes(32);
const noopAttempt = { headers() {}, chunk() {}, payload() {}, cancelled() {} };
const disabled = { run: (_mode, _request, task) => task(noopAttempt), retry() {} };
const safeLabel = (value) => {
  const text = String(value ?? "");
  return /^[a-zA-Z0-9_.:/-]{1,128}$/.test(text) && !text.startsWith("sk-") ? text : undefined;
};
const errorCategory = (value) => {
  const text = String(value ?? "").toLowerCase();
  if (/^http_\d{3}$/.test(text)) return text;
  if (["empty", "timeout", "aborted", "stream_body_unavailable", "provider_not_configured"].includes(text)) return text;
  if (text.includes("fetch") || text.includes("socket") || text.includes("network")) return "transport_error";
  return text ? "other" : undefined;
};
const finishCategory = (value) => {
  const text = String(value ?? "").toLowerCase();
  return ["stop", "length", "max_tokens", "content_filter", "tool_calls", "function_call", "safety", "recitation", "insufficient_system_resource", "aborted"].includes(text) ? text : text ? "other" : undefined;
};

export function createLlmDiagnostics(provider, request) {
  if (!request.performanceTrace?.start) return disabled;
  let common;
  try {
    const input = JSON.stringify([request.system ?? "", request.messages ?? []]);
    common = {
      requestId: safeLabel(request.performanceTrace.snapshot?.().requestId),
      callId: randomUUID(),
      slot: safeLabel(provider?.slot) || "single",
      model: safeLabel(provider?.model),
      protocol: safeLabel(provider?.protocol),
      inputChars: input.length,
      inputFingerprint: createHmac("sha256", inputSalt).update(input).digest("hex").slice(0, 24),
      maxTokens: Number.isFinite(request.maxTokens) ? request.maxTokens : undefined,
    };
  } catch { return disabled; }
  let number = 0;
  let retryReason;
  const log = (event, fields) => {
    try { console.log("[llm-diagnostic]", JSON.stringify({ event, ...common, ...fields })); } catch {}
  };
  return {
    retry(result, nextMode) {
      retryReason = errorCategory(result?.error) || "compatibility_fallback";
      log("retry", { attempt: number, reason: retryReason, status: result?.status, nextMode });
    },
    async run(mode, currentRequest, task) {
      const attempt = ++number;
      const startedAt = Date.now();
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const fields = {
        attempt, mode, startedAt, retryReason,
        timingMode: mode === "non_stream" ? "body_end_only" : "stream_events",
        timeoutMs: Math.min(360_000, Math.max(1_000, Number(currentRequest.timeoutMs) || 120_000)),
        contentChars: 0, reasoningChars: 0, chunks: 0, maxChunkGapMs: 0,
      };
      let endStage;
      try { endStage = request.performanceTrace.start(`llm.attempt.${common.slot}`, { callId: common.callId, attempt, mode }); } catch {}
      log("start", fields);
      let lastChunk;
      const observer = {
        headers(response) {
          fields.headersMs = elapsed();
          fields.httpStatus = response.status;
          const type = response.headers?.get("content-type") || "";
          fields.contentType = type.includes("text/event-stream") ? "sse" : type.includes("json") ? "json" : "other";
          fields.upstreamRequestId = safeLabel(response.headers?.get("x-request-id"));
          log("headers", { attempt, mode, headersMs: fields.headersMs, httpStatus: fields.httpStatus, contentType: fields.contentType });
        },
        chunk() {
          const ms = elapsed();
          if (lastChunk === undefined) fields.firstChunkMs = ms;
          else fields.maxChunkGapMs = Math.max(fields.maxChunkGapMs, ms - lastChunk);
          lastChunk = ms;
          fields.chunks++;
        },
        payload(json, isGemini, streaming) {
          const choice = json?.choices?.[0];
          const parts = json?.candidates?.[0]?.content?.parts || [];
          const message = streaming ? choice?.delta ?? choice?.message : choice?.message;
          const size = (value) => typeof value === "string" ? value.length : Array.isArray(value) ? value.reduce((n, part) => n + String(typeof part === "string" ? part : part?.text ?? "").length, 0) : 0;
          const content = isGemini ? parts.filter((p) => p.thought !== true).reduce((n, p) => n + size(p.text), 0) : size(message?.content);
          const reasoning = isGemini ? parts.filter((p) => p.thought === true).reduce((n, p) => n + size(p.text), 0) : size(message?.reasoning_content);
          for (const [kind, count] of [["content", content], ["reasoning", reasoning]]) {
            fields[`${kind}Chars`] += count;
            const key = kind === "content" ? "firstContentMs" : "firstReasoningMs";
            if (count && fields[key] === undefined) {
              fields[key] = elapsed();
              log(`first_${kind}`, { attempt, mode, elapsedMs: fields[key], observedAtBodyEnd: !streaming });
            }
          }
          if (!streaming) fields.bodyCompleteMs = elapsed();
          const finish = isGemini ? json?.candidates?.[0]?.finishReason : choice?.finish_reason;
          if (finish) fields.finishReason = finishCategory(finish);
          const model = safeLabel(json?.modelVersion ?? json?.model);
          if (model) fields.responseModel = model;
          const usage = isGemini ? json?.usageMetadata : json?.usage;
          if (usage) {
            const tokens = {
              inputTokens: isGemini ? usage.promptTokenCount : usage.prompt_tokens,
              outputTokens: isGemini ? usage.candidatesTokenCount : usage.completion_tokens,
              reasoningTokens: isGemini ? usage.thoughtsTokenCount : usage.completion_tokens_details?.reasoning_tokens,
              totalTokens: isGemini ? usage.totalTokenCount : usage.total_tokens,
            };
            for (const [key, value] of Object.entries(tokens)) if (Number.isFinite(value) && value >= 0) fields[key] = value;
          }
        },
        cancelled(kind) { fields.abortKind = kind; },
      };
      // Observability must never turn an otherwise successful response into an error.
      for (const [name, method] of Object.entries(observer)) observer[name] = (...args) => { try { method(...args); } catch {} };
      let result;
      let thrown;
      try {
        result = await task(observer);
        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        fields.durationMs = elapsed();
        if (lastChunk !== undefined) fields.lastChunkAgeMs = fields.durationMs - lastChunk;
        fields.resultOk = Boolean(result?.ok);
        fields.resultStatus = result?.status;
        fields.errorCategory = errorCategory(result?.error || thrown?.name);
        fields.outcome = fields.contentChars > 0 ? "content" : fields.reasoningChars > 0 ? "reasoning_only" : "no_content";
        log("end", fields);
        try { endStage?.({ ...fields, ok: fields.resultOk }); } catch {}
      }
    },
  };
}
