const KEY_STORAGE = "paper-query-openai-key-v1";
const MODEL_STORAGE = "paper-query-openai-model-v1";
/** OpenAI 兼容的 POST …/chat/completions 完整地址（通义、DeepSeek、本地 Ollama 等） */
const CHAT_URL_STORAGE = "paper-query-llm-chat-url-v1";

export function getOpenAiKey(): string | undefined {
  try {
    const v = localStorage.getItem(KEY_STORAGE)?.trim();
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

export function setOpenAiKey(value: string) {
  const v = value.trim();
  if (!v) {
    localStorage.removeItem(KEY_STORAGE);
    return;
  }
  localStorage.setItem(KEY_STORAGE, v);
}

export function clearOpenAiKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

export function getOpenAiModel(): string | undefined {
  try {
    const v = localStorage.getItem(MODEL_STORAGE)?.trim();
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

export function setOpenAiModel(value: string) {
  const v = value.trim();
  if (!v) {
    localStorage.removeItem(MODEL_STORAGE);
    return;
  }
  localStorage.setItem(MODEL_STORAGE, v);
}

export function clearOpenAiModel() {
  try {
    localStorage.removeItem(MODEL_STORAGE);
  } catch {
    /* ignore */
  }
}

export function getLlmChatCompletionsUrl(): string | undefined {
  try {
    const v = localStorage.getItem(CHAT_URL_STORAGE)?.trim();
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

export function setLlmChatCompletionsUrl(value: string) {
  const v = value.trim();
  if (!v) {
    localStorage.removeItem(CHAT_URL_STORAGE);
    return;
  }
  localStorage.setItem(CHAT_URL_STORAGE, v);
}

export function clearLlmChatCompletionsUrl() {
  try {
    localStorage.removeItem(CHAT_URL_STORAGE);
  } catch {
    /* ignore */
  }
}
