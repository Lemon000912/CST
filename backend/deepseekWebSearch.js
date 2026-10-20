/** DeepSeek official Search and Fetch API adapters. */

import crypto from "node:crypto";

const API_BASE = "https://api.deepseek.com/v1/tools";

function cleanText(value, max = 6000) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function codePointSlice(value, max) {
  return Array.from(String(value ?? "")).slice(0, max).join("");
}

export function getDeepseekWebSearchConfig() {
  const apiKey = String(process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const base = String(process.env.DEEPSEEK_TOOLS_BASE_URL ?? API_BASE).trim().replace(/\/+$/, "");
  return {
    apiKey,
    searchUrl: String(process.env.DEEPSEEK_SEARCH_URL ?? `${base}/search`).trim(),
    fetchUrl: String(process.env.DEEPSEEK_FETCH_URL ?? `${base}/fetch`).trim(),
    timeoutMs: Math.min(120_000, Math.max(5000, Number(process.env.DEEPSEEK_SEARCH_TIMEOUT_MS) || 35_000)),
    maxResults: Math.min(50, Math.max(1, Number(process.env.DEEPSEEK_SEARCH_MAX_RESULTS) || 10)),
  };
}

async function postDeepseek(url, payload, cfg, signal) {
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", relay, { once: true });
  if (signal?.aborted) relay();
  const timer = setTimeout(() => controller.abort(new Error("DeepSeek API timeout")), cfg.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    if (!response.ok) return { ok: false, note: `http_${response.status}` };
    return { ok: true, body };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, note: controller.signal.aborted ? "timeout" : `err:${String(error?.message || error).slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

function resultRows(body) {
  const data = body?.data ?? body?.result ?? body;
  const rows = data?.results ?? data?.search_results ?? data?.items ?? [];
  return Array.isArray(rows) ? rows : [];
}

function toPapers(rows, max) {
  const seen = new Set();
  return rows.slice(0, max).flatMap((row, index) => {
    const url = String(row?.url ?? row?.link ?? "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return [];
    seen.add(url);
    const title = cleanText(row.title ?? row.name ?? url, 500) || url;
    const content = cleanText(row.content ?? row.summary ?? row.snippet ?? row.description ?? "", 6000);
    const id = crypto.createHash("sha256").update(`${url}\n${index}`).digest("hex").slice(0, 22);
    return [{
      paper_id: `deepseek_web:${id}`, doi: null, title,
      abstract: content || title, summary: content || title,
      year: row.date ? Number(String(row.date).slice(0, 4)) || null : null,
      venue: "Web (DeepSeek)", published: row.date ?? "", oa_status: null,
      authors: [], authors_json: "[]", id, absUrl: url, pdfUrl: url,
      source: "deepseek_web", webProviderLabel: "DeepSeek Search",
      isReferencedByCount: null,
    }];
  });
}

/** Query is limited to the API's 128 Unicode code point maximum. */
export async function fetchDeepseekWebPapers(query, max = 10, opts = {}) {
  const cfg = getDeepseekWebSearchConfig();
  const q = codePointSlice(String(query ?? "").replace(/\s+/g, " ").trim(), 128);
  if (!q) return { papers: [], note: "empty-query", toolName: "deepseek-search" };
  if (!cfg) return { papers: [], note: "not-configured", toolName: "deepseek-search" };
  const count = Math.min(50, Math.max(1, Number(max) || cfg.maxResults));
  const result = await postDeepseek(cfg.searchUrl, { query: q, count }, cfg, opts.signal);
  if (!result.ok) return { papers: [], note: result.note, toolName: "deepseek-search" };
  const papers = toPapers(resultRows(result.body), count);
  return { papers, note: papers.length ? `ok:${papers.length}` : "ok_no_results", toolName: "deepseek-search" };
}

export async function fetchDeepseekWebPage(url, opts = {}) {
  const cfg = getDeepseekWebSearchConfig();
  const target = String(url ?? "").trim();
  if (!cfg) return { ok: false, error: "not-configured" };
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: "invalid-url" };
  const result = await postDeepseek(cfg.fetchUrl, { url: target }, cfg, opts.signal);
  if (!result.ok) return { ok: false, error: result.note };
  const data = result.body?.data ?? result.body?.result ?? result.body;
  const content = cleanText(typeof data === "string" ? data : data?.content ?? data?.text ?? data?.markdown ?? "", 12_000);
  if (content.length < 30) return { ok: false, error: "no_extractable_text" };
  return { ok: true, title: cleanText(data?.title ?? "", 500), text: content, finalUrl: data?.url || target, via: "deepseek_fetch" };
}
