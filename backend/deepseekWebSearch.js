/**
 * Redfox Hub DeepSeek WebSearch adapter.
 *
 * The community Skill is a Python wrapper around the same two HTTP endpoints.
 * The project backend uses fetch directly so user searches can call it without
 * depending on a local Codex/WorkBuddy process.
 */

import crypto from "node:crypto";

const DEFAULT_BASE = "https://redfox.hk/story/api/deepSearch";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stableId(url, index) {
  return crypto
    .createHash("sha256")
    .update(`${url}\n${index}`)
    .digest("hex")
    .slice(0, 22);
}

function cleanText(value, max = 1800) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function candidateUrl(value) {
  const url = String(value ?? "").trim().replace(/[),.;，。；）】]+$/g, "");
  return /^https?:\/\//i.test(url) ? url : "";
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/**
 * Extract citation-like objects from the API's loosely documented
 * search_result field. The API has returned arrays and nested objects in
 * different clients, so this intentionally accepts common URL/title fields.
 */
export function extractDeepseekCitations(searchResult, answer = "", max = 48) {
  const out = [];
  const seen = new Set();
  const answerText = cleanText(answer, 2600);
  const walk = (value, depth = 0) => {
    if (depth > 12 || out.length >= max || value == null) return;
    const parsed = parseMaybeJson(value);
    if (parsed !== value) return walk(parsed, depth + 1);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === "string") {
      const matches = value.match(/https?:\/\/[^\s<>"'\]})，。；】]+/gi) || [];
      for (const raw of matches) {
        const url = candidateUrl(raw);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, title: url, summary: answerText });
        if (out.length >= max) break;
      }
      return;
    }
    if (typeof value !== "object") return;
    const row = asRecord(value);
    const url = candidateUrl(row.url ?? row.link ?? row.href ?? row.uri ?? row.source_url);
    if (url && !seen.has(url)) {
      seen.add(url);
      const title = cleanText(row.title ?? row.name ?? row.heading ?? row.source ?? url, 500) || url;
      const summary = cleanText(
        row.content ?? row.snippet ?? row.description ?? row.summary ?? row.text ?? answerText,
        2600,
      ) || answerText || title;
      out.push({ url, title, summary });
      if (out.length >= max) return;
    }
    for (const [key, child] of Object.entries(row)) {
      // Avoid walking very large answer blobs twice; citation fields and
      // nested objects are still traversed.
      if (key === "content" && typeof child === "string" && child === answer) continue;
      walk(child, depth + 1);
      if (out.length >= max) return;
    }
  };
  walk(searchResult);
  return out;
}

function citationsToPapers(citations, answer, max) {
  const answerText = cleanText(answer, 2600);
  return citations.slice(0, max).map((item, index) => {
    const url = item.url;
    const summary = cleanText(item.summary || answerText || item.title, 2600);
    const id = stableId(url, index);
    return {
      paper_id: `deepseek_web:${id}`,
      doi: null,
      title: item.title || url,
      abstract: summary,
      summary,
      year: null,
      venue: "Web (DeepSeek)",
      published: "",
      oa_status: null,
      authors: [],
      authors_json: JSON.stringify([]),
      id,
      absUrl: url,
      pdfUrl: url,
      source: "deepseek_web",
      webProviderLabel: "DeepSeek WebSearch",
      deepseekAnswer: answerText,
      isReferencedByCount: null,
    };
  });
}

/** @returns {null | { apiKey: string, submitUrl: string, resultUrl: string, timeoutMs: number, pollIntervalMs: number, maxAttempts: number, maxResults: number }} */
export function getDeepseekWebSearchConfig() {
  const apiKey = String(process.env.REDFOX_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const base = String(process.env.REDFOX_DEEPSEARCH_BASE ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  return {
    apiKey,
    submitUrl: `${base}/dsSubmit`,
    resultUrl: `${base}/dsResult`,
    timeoutMs: Math.min(120_000, Math.max(5000, Number(process.env.REDFOX_DEEPSEARCH_TIMEOUT_MS) || 30_000)),
    pollIntervalMs: Math.min(30_000, Math.max(500, Number(process.env.REDFOX_DEEPSEARCH_POLL_MS) || 5000)),
    maxAttempts: Math.min(120, Math.max(1, Number(process.env.REDFOX_DEEPSEARCH_MAX_ATTEMPTS) || 60)),
    maxResults: Math.min(60, Math.max(1, Number(process.env.REDFOX_DEEPSEARCH_MAX_RESULTS) || 32)),
  };
}

function abortError(signal) {
  return signal?.reason ?? new DOMException("Search cancelled", "AbortError");
}

async function fetchJson(url, body, cfg, signal) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", relay, { once: true });
  if (signal?.aborted) relay();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        REDFOX_API_KEY: cfg.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!response.ok) return { ok: false, status: response.status, body: json ?? text };
    return { ok: true, status: response.status, body: json };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** @returns {Promise<{papers: object[]; note: string; toolName: string; answer?: string}>} */
export async function fetchDeepseekWebPapers(query, max, opts = {}) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  const cfg = getDeepseekWebSearchConfig();
  if (!q) return { papers: [], note: "empty-query", toolName: "deepseek" };
  if (!cfg) return { papers: [], note: "not-configured", toolName: "deepseek" };
  const cap = Math.min(Math.max(1, Number(max) || cfg.maxResults), cfg.maxResults);
  try {
    const submit = await fetchJson(
      cfg.submitUrl,
      { inquiryText: q, source: "Deepseek WebSearch-Project" },
      cfg,
      opts.signal,
    );
    if (!submit.ok) return { papers: [], note: `http_${submit.status}`, toolName: "deepseek" };
    const taskId = String(asRecord(asRecord(submit.body).data).taskId ?? "").trim();
    if (!taskId) return { papers: [], note: "submit_missing_task_id", toolName: "deepseek" };

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
      await wait(cfg.pollIntervalMs, opts.signal);
      const result = await fetchJson(cfg.resultUrl, { taskId }, cfg, opts.signal);
      if (!result.ok) {
        if (result.status === 502 || result.status >= 500) continue;
        return { papers: [], note: `http_${result.status}`, toolName: "deepseek" };
      }
      const data = asRecord(result.body?.data);
      const status = String(data.status ?? "").toLowerCase();
      if (status === "failed") {
        const reason = cleanText(data.failReason ?? data.error ?? "task_failed", 120);
        return { papers: [], note: `failed:${reason}`, toolName: "deepseek" };
      }
      if (status !== "succeeded" && status !== "completed") continue;
      const resultBody = asRecord(parseMaybeJson(data.result));
      const answer = cleanText(resultBody.content ?? resultBody.answer ?? data.content ?? "", 6000);
      const citations = extractDeepseekCitations(resultBody.search_result ?? resultBody.searchResult ?? resultBody.sources, answer, cap);
      const papers = citationsToPapers(citations, answer, cap);
      return {
        papers,
        answer,
        note: papers.length ? `ok:${papers.length}` : "ok_no_citations",
        toolName: "deepseek",
      };
    }
    return { papers: [], note: "timeout", toolName: "deepseek" };
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    const msg = error?.name === "AbortError" ? "timeout" : String(error?.message || error).slice(0, 120);
    return { papers: [], note: `err:${msg}`, toolName: "deepseek" };
  }
}
