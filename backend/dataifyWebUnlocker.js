/**
 * Dataify 通用采集 / Web Unlocker（按 URL 拉 HTML，支持 JS 渲染）。
 * POST https://webunlocker.dataify.com/request
 * 文档与控制台「运行请求」示例一致；复用 DATAIFY_API_KEY。
 */

import { fetchWithTimeout } from "./fetchWithTimeout.js";

/** @returns {null | { apiKey: string; requestUrl: string; jsRender: string; country: string; type: string; followRedirect: string; isJson: string; timeoutMs: number; mode: "off" | "fallback" | "always" }} */
export function getDataifyWebUnlockerConfig() {
  const apiKey = String(process.env.DATAIFY_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const modeRaw = String(process.env.DATAIFY_WEBUNLOCKER_MODE ?? "fallback").trim().toLowerCase();
  const mode = modeRaw === "always" || modeRaw === "off" ? modeRaw : "fallback";
  if (mode === "off") return null;
  if (/^(0|false|no)$/i.test(String(process.env.DATAIFY_WEBUNLOCKER_ENABLED ?? "1").trim())) {
    return null;
  }

  const timeoutMs = Math.min(
    120_000,
    Math.max(8000, Number(process.env.DATAIFY_WEBUNLOCKER_TIMEOUT_MS) || 45_000),
  );

  return {
    apiKey,
    requestUrl:
      String(process.env.DATAIFY_WEBUNLOCKER_URL ?? "").trim() ||
      "https://webunlocker.dataify.com/request",
    jsRender: String(process.env.DATAIFY_WEBUNLOCKER_JS_RENDER ?? "True").trim() || "True",
    country: String(process.env.DATAIFY_WEBUNLOCKER_COUNTRY ?? "us").trim() || "us",
    type: String(process.env.DATAIFY_WEBUNLOCKER_TYPE ?? "html").trim() || "html",
    followRedirect: String(process.env.DATAIFY_WEBUNLOCKER_FOLLOW_REDIRECT ?? "True").trim() || "True",
    isJson: String(process.env.DATAIFY_WEBUNLOCKER_ISJSON ?? "1").trim() || "1",
    timeoutMs,
    mode,
  };
}

/**
 * @param {string} pageUrl
 * @param {NonNullable<ReturnType<typeof getDataifyWebUnlockerConfig>>} cfg
 */
export async function fetchDataifyWebUnlockerHtml(pageUrl, cfg) {
  const u = String(pageUrl ?? "").trim();
  if (!u) return { ok: false, error: "empty_url", html: "", finalUrl: "" };

  const body = {
    url: u,
    type: cfg.type,
    js_render: cfg.jsRender,
    block_resources: "",
    clean_content: "",
    country: cfg.country,
    headers: "",
    cookies: "",
    wait: "",
    wait_for: "",
    follow_redirect: cfg.followRedirect,
    isjson: cfg.isJson,
  };

  try {
    const res = await fetchWithTimeout(
      cfg.requestUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "QuantumPinnacle/1.0",
        },
        body: JSON.stringify(body),
      },
      cfg.timeoutMs,
    );
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `dataify_http_${res.status}:${text.slice(0, 80)}`,
        html: "",
        finalUrl: u,
      };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (text.length > 200 && /<html[\s>]/i.test(text)) {
        return { ok: true, error: null, html: text, finalUrl: u };
      }
      return { ok: false, error: "dataify_non_json", html: "", finalUrl: u };
    }
    const o = /** @type {Record<string, unknown>} */ (json);
    const code = o.code;
    if (typeof code === "number" && code !== 200 && code !== 0) {
      const msg = String(o.message ?? o.msg ?? "").slice(0, 120);
      return { ok: false, error: `dataify_code_${code}:${msg}`, html: "", finalUrl: u };
    }
    const html = String(o.html ?? o.data ?? o.body ?? "").trim();
    if (!html || html.length < 80) {
      return { ok: false, error: "dataify_empty_html", html: "", finalUrl: String(o.url ?? u) };
    }
    return {
      ok: true,
      error: null,
      html,
      finalUrl: String(o.url ?? u),
      responseTime: o.response_time != null ? String(o.response_time) : null,
    };
  } catch (e) {
    return {
      ok: false,
      error: `dataify_err:${String(e?.message || e).slice(0, 100)}`,
      html: "",
      finalUrl: u,
    };
  }
}
