import { normalizeDoiString } from "./doi.js";

/**
 * 使用 Unpaywall 开放 API 查询 DOI 的开放获取链接（合规，需邮箱）。
 * @see https://unpaywall.org/products/api
 * @param {string} doiRaw
 * @returns {Promise<{ ok: boolean; error?: string; doi?: string; is_oa?: boolean; pdf_url?: string | null; landing_url?: string | null; oa_status?: string | null }>}
 */
export async function lookupUnpaywallOa(doiRaw) {
  const email = String(process.env.UNPAYWALL_EMAIL ?? process.env.OPENALEX_CONTACT_EMAIL ?? "").trim();
  if (!email) {
    return {
      ok: false,
      error: "未配置 UNPAYWALL_EMAIL 或 OPENALEX_CONTACT_EMAIL（项目根 .env），无法查询 Unpaywall。",
    };
  }
  const doi = normalizeDoiString(doiRaw);
  if (!/^10\.\d{4,9}\//.test(doi)) {
    return { ok: false, error: "无效 DOI" };
  }
  const q = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  try {
    const res = await fetch(q, { signal: ac.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `Unpaywall HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const data = await res.json();
    const loc = data?.best_oa_location && typeof data.best_oa_location === "object" ? data.best_oa_location : null;
    const pdfFromLoc = loc?.url_for_pdf ? String(loc.url_for_pdf).trim() : "";
    const land = loc?.url ? String(loc.url).trim() : "";
    const pdf_url = pdfFromLoc || (land.toLowerCase().endsWith(".pdf") ? land : "") || null;
    const landing_url = land || null;
    return {
      ok: true,
      doi,
      is_oa: Boolean(data?.is_oa),
      oa_status: data?.oa_status != null ? String(data.oa_status) : null,
      pdf_url,
      landing_url,
    };
  } catch (e) {
    if (e?.name === "AbortError") {
      return { ok: false, error: "Unpaywall 请求超时" };
    }
    return { ok: false, error: e?.message || "Unpaywall 请求失败" };
  } finally {
    clearTimeout(timer);
  }
}
