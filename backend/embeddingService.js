/**
 * OpenAI 兼容 Embeddings API（可选）：用于 query↔摘要 向量相似度重排。
 */
import { resolveApiKey, safeHttpUrl } from "./rewrite.js";

const DEFAULT_EMBEDDING_PATH = "/v1/embeddings";

/** @returns {boolean} */
export function isEmbeddingEnabled() {
  if (/^(0|false|off|no)$/i.test(String(process.env.SEMANTIC_EMBEDDING_ENABLED ?? "").trim())) {
    return false;
  }
  return /^(1|true|on|yes)$/i.test(String(process.env.SEMANTIC_EMBEDDING_ENABLED ?? "").trim());
}

export function resolveEmbeddingsUrl(fromClient) {
  const direct = safeHttpUrl(process.env.EMBEDDING_API_URL);
  if (direct) return direct;
  const client = safeHttpUrl(fromClient);
  if (client) {
    if (/\/embeddings\/?$/i.test(client)) return client;
    return client.replace(/\/chat\/completions\/?$/i, "/embeddings");
  }
  const chat = safeHttpUrl(process.env.LLM_CHAT_COMPLETIONS_URL);
  if (chat) {
    if (/\/embeddings\/?$/i.test(chat)) return chat;
    return chat.replace(/\/chat\/completions\/?$/i, "/embeddings");
  }
  return "";
}

export function defaultEmbeddingModel() {
  const m = String(process.env.EMBEDDING_MODEL ?? process.env.LLM_EMBEDDING_MODEL ?? "").trim();
  return m || "text-embedding-3-small";
}

/**
 * @param {string[]} texts
 * @param {{ apiKey?: string; model?: string; embeddingsUrl?: string }} [opts]
 * @returns {Promise<number[][]|null>}
 */
export async function embedTexts(texts, opts = {}) {
  if (!isEmbeddingEnabled()) return null;
  const inputs = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t ?? "").trim().slice(0, 6000))
    .filter(Boolean);
  if (!inputs.length) return null;

  const url = resolveEmbeddingsUrl(opts.embeddingsUrl);
  const key = resolveApiKey(opts.apiKey);
  if (!url || !key) return null;

  const model = String(opts.model ?? defaultEmbeddingModel()).trim();
  const controller = new AbortController();
  const timeoutMs = Math.min(
    45000,
    Math.max(8000, Number(process.env.EMBEDDING_TIMEOUT_MS) || 20000),
  );
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({ model, input: inputs.length === 1 ? inputs[0] : inputs }),
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      const t = await r.text();
      console.warn("[embedding] HTTP", r.status, t.slice(0, 300));
      return null;
    }
    const j = await r.json();
    const data = Array.isArray(j?.data) ? j.data : [];
    if (!data.length) return null;
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map((row) => {
      const emb = row?.embedding;
      return Array.isArray(emb) ? emb.map(Number) : [];
    });
    if (vectors.some((v) => !v.length)) return null;
    return vectors;
  } catch (e) {
    clearTimeout(timeoutId);
    console.warn("[embedding] error", e?.message || e);
    return null;
  }
}

/** @param {number[]} a @param {number[]} b */
export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
