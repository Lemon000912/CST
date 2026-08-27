import { normalizeDoiString } from "./doi.js";
import { lookupUnpaywallOa } from "./unpaywallOa.js";

const API_TIMEOUT_MS = 15_000;

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(options.headers ?? {}) },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pushUrl(output, seen, value, provider) {
  const url = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
  seen.add(url);
  output.push({ url, provider });
}

async function resolveOpenAlex(doi, output, seen) {
  const email = String(process.env.OPENALEX_CONTACT_EMAIL ?? process.env.UNPAYWALL_EMAIL ?? "").trim();
  const endpoint = new URL(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`);
  if (email) endpoint.searchParams.set("mailto", email);
  const data = await fetchJson(endpoint, {
    headers: { "User-Agent": `QuantumPinnacle/1.1${email ? ` (mailto:${email.slice(0, 120)})` : ""}` },
  });
  if (!data || typeof data !== "object") return;
  const locations = [data.best_oa_location, data.primary_location, ...(data.locations ?? [])];
  for (const location of locations) {
    pushUrl(output, seen, location?.pdf_url, "openalex");
    if (location?.is_oa || location === data.best_oa_location) {
      pushUrl(output, seen, location?.landing_page_url, "openalex");
    }
  }
}

async function resolveSemanticScholar(doi, output, seen) {
  const endpoint = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=openAccessPdf`;
  const data = await fetchJson(endpoint);
  pushUrl(output, seen, data?.openAccessPdf?.url, "semantic_scholar");
}

async function resolveEuropePmc(doi, output, seen) {
  const endpoint = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  endpoint.searchParams.set("query", `DOI:\"${doi}\"`);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("resultType", "core");
  endpoint.searchParams.set("pageSize", "5");
  const data = await fetchJson(endpoint);
  for (const row of data?.resultList?.result ?? []) {
    if (!/^(?:y|true|1)$/i.test(String(row?.isOpenAccess ?? ""))) continue;
    const pmcid = String(row?.pmcid ?? "").trim();
    if (pmcid) {
      pushUrl(output, seen, `https://europepmc.org/articles/${encodeURIComponent(pmcid)}?pdf=render`, "europe_pmc");
    }
    for (const item of row?.fullTextUrlList?.fullTextUrl ?? []) {
      if (String(item?.availabilityCode ?? "").toUpperCase() === "OA") {
        pushUrl(output, seen, item?.url, "europe_pmc");
      }
    }
  }
}

async function resolveUnpaywall(doi, output, seen) {
  const result = await lookupUnpaywallOa(doi);
  if (!result?.ok || !result?.is_oa) return;
  pushUrl(output, seen, result.pdf_url, "unpaywall");
  pushUrl(output, seen, result.landing_url, "unpaywall");
}

/** Return only lawful public/OA candidates. Provider failures are isolated. */
export async function resolveOpenAccessPdfCandidates(rawDoi) {
  const doi = normalizeDoiString(rawDoi);
  if (!/^10\.\d{4,9}\//i.test(doi)) return [];
  const output = [];
  const seen = new Set();
  await Promise.allSettled([
    resolveOpenAlex(doi, output, seen),
    resolveUnpaywall(doi, output, seen),
    resolveEuropePmc(doi, output, seen),
    resolveSemanticScholar(doi, output, seen),
  ]);
  return output.slice(0, 12);
}
