/** Redfox Hub DeepSeek WebSearch adapter. */
import crypto from "node:crypto";

const DEFAULT_BASE = "https://redfox.hk/story/api/deepSearch";

function cleanText(value, max = 5000) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function getRedfoxDeepseekConfig() {
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

async function postJson(url, body, cfg, signal) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", relay, { once: true });
  if (signal?.aborted) relay();
  const timer = setTimeout(() => controller.abort(new Error("Redfox DeepSeek timeout")), cfg.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { REDFOX_API_KEY: cfg.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return response.ok ? { ok: true, data } : { ok: false, note: `http_${response.status}` };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, note: controller.signal.aborted ? "timeout" : `err:${String(error?.message || error).slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function citationsToPapers(value, answer, max) {
  const rows = [];
  const seen = new Set();
  const walk = (node, depth = 0) => {
    if (depth > 10 || !node || rows.length >= max) return;
    const parsed = parseMaybeJson(node);
    if (parsed !== node) { walk(parsed, depth + 1); return; }
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node === "string") {
      const urls = node.match(/https?:\/\/[^\s<>"'\]})，。；】]+/gi) ?? [];
      for (const raw of urls) {
        const url = raw.replace(/[),.;，。；）】]+$/g, "");
        if (!seen.has(url)) { seen.add(url); rows.push({ url, title: url, summary: cleanText(answer, 5000) }); }
        if (rows.length >= max) break;
      }
      return;
    }
    if (typeof node !== "object") return;
    const url = String(node.url ?? node.link ?? node.href ?? node.uri ?? node.source_url ?? node.sourceUrl ?? node.web_url ?? node.webUrl ?? "").trim();
    if (/^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      rows.push({ url, title: cleanText(node.title ?? node.name ?? node.heading ?? url, 500), summary: cleanText(node.content ?? node.snippet ?? node.description ?? node.summary ?? node.text ?? answer, 5000) });
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  };
  walk(value);
  return rows.slice(0, max).map((row, index) => {
    const id = crypto.createHash("sha256").update(`${row.url}\n${index}`).digest("hex").slice(0, 22);
    return {
      paper_id: `deepseek_web:${id}`, doi: null, title: row.title || row.url,
      abstract: row.summary || row.title, summary: row.summary || row.title,
      year: null, venue: "Web (Redfox DeepSeek)", published: "", oa_status: null,
      authors: [], authors_json: "[]", id, absUrl: row.url, pdfUrl: row.url,
      source: "deepseek_web", webProviderLabel: "Redfox DeepSeek WebSearch",
      redfoxAnswer: answer, isReferencedByCount: null,
    };
  });
}

/** @returns {Promise<{papers: object[]; note: string; toolName: string; answer?: string}>} */
export async function fetchRedfoxDeepseekPapers(query, max = 32, opts = {}) {
  const cfg = getRedfoxDeepseekConfig();
  const q = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!q) return { papers: [], note: "empty-query", toolName: "redfox-deepseek" };
  if (!cfg) return { papers: [], note: "not-configured", toolName: "redfox-deepseek" };
  const cap = Math.min(Math.max(1, Number(max) || cfg.maxResults), cfg.maxResults);
  try {
    const submit = await postJson(cfg.submitUrl, { inquiryText: q, source: "Deepseek WebSearch-GitHub" }, cfg, opts.signal);
    if (!submit.ok) return { papers: [], note: submit.note, toolName: "redfox-deepseek" };
    const taskId = String(submit.data?.data?.taskId ?? "").trim();
    if (!taskId) return { papers: [], note: "submit_missing_task_id", toolName: "redfox-deepseek" };
    for (let attempt = 0; attempt < cfg.maxAttempts; attempt += 1) {
      await wait(cfg.pollIntervalMs, opts.signal);
      const poll = await postJson(cfg.resultUrl, { taskId }, cfg, opts.signal);
      if (!poll.ok) continue;
      const data = poll.data?.data ?? {};
      const status = String(data.status ?? "").toLowerCase();
      if (status === "failed") return { papers: [], note: `failed:${cleanText(data.failReason ?? "task_failed", 120)}`, toolName: "redfox-deepseek" };
      if (status !== "succeeded" && status !== "completed") continue;
      const result = parseMaybeJson(data.result ?? {}) ?? {};
      const answer = cleanText(result.content ?? data.content ?? "", 6000);
      const citations = result.search_result ?? result.searchResult ?? result.references ?? result.sources ?? result.citations ?? result.data ?? [];
      const papers = citationsToPapers(citations, answer, cap);
      const note = papers.length
        ? `ok:${papers.length}`
        : `ok_no_citations:result_${typeof result};keys_${typeof result === "object" ? Object.keys(result).slice(0, 12).join("+") || "none" : "none"}`;
      return { papers, answer, note, toolName: "redfox-deepseek" };
    }
    return { papers: [], note: "timeout", toolName: "redfox-deepseek" };
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    return { papers: [], note: `err:${String(error?.message || error).slice(0, 120)}`, toolName: "redfox-deepseek" };
  }
}
