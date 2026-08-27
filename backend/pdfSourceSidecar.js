import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPdfFromSourcesSecurely } from "./pdfFulfillment.js";
import { resolveOpenAccessPdfCandidates } from "./openAccessPdf.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(MODULE_DIR, "data", "pdf-source-cache");
const PDF_SIGNATURE = Buffer.from("%PDF-");
const jobs = new Map();

function cacheRoot(options = {}) {
  return path.resolve(String(options.cacheDir ?? process.env.PDF_SOURCE_CACHE_DIR ?? DEFAULT_ROOT));
}

function artifactKey(paper) {
  const identity = JSON.stringify({
    doi: String(paper?.doi ?? "").trim().toLowerCase(),
    pdfUrl: String(paper?.pdfUrl ?? paper?.pdf_url ?? "").trim(),
    absUrl: String(paper?.absUrl ?? paper?.abs_url ?? "").trim(),
    paperId: String(paper?.paper_id ?? paper?.paperId ?? paper?.id ?? "").trim(),
  });
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function operationKey(operationId) {
  return crypto.createHash("sha256").update(String(operationId ?? "")).digest("hex");
}

function artifactPaths(key, options = {}) {
  const root = cacheRoot(options);
  return {
    pdf: path.join(root, "artifacts", `${key}.pdf`),
    meta: path.join(root, "artifacts", `${key}.json`),
  };
}

function manifestPath(operationId, options = {}) {
  return path.join(cacheRoot(options), "jobs", `${operationKey(operationId)}.json`);
}

function isPdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).equals(PDF_SIGNATURE);
}

async function writeJsonAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { flag: "wx" });
  try {
    await fs.rename(temp, filename);
  } catch (error) {
    if (!/^(?:EEXIST|EPERM|ENOTEMPTY)$/i.test(String(error?.code ?? ""))) throw error;
    await fs.unlink(filename).catch(() => undefined);
    await fs.rename(temp, filename);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function loadArtifact(paper, options = {}) {
  const key = artifactKey(paper);
  const files = artifactPaths(key, options);
  try {
    const [buffer, rawMeta] = await Promise.all([
      fs.readFile(files.pdf),
      fs.readFile(files.meta, "utf8").catch(() => "{}"),
    ]);
    if (!isPdf(buffer)) {
      await Promise.allSettled([fs.unlink(files.pdf), fs.unlink(files.meta)]);
      return null;
    }
    let meta = {};
    try { meta = JSON.parse(rawMeta); } catch { /* ignore stale metadata */ }
    return { key, buffer, contentType: "application/pdf", finalUrl: String(meta.finalUrl ?? ""), cached: true };
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("[pdf-sidecar] cache read", error?.message || error);
    return null;
  }
}

async function saveArtifact(paper, artifact, options = {}) {
  if (!isPdf(artifact?.buffer)) throw new Error("PDF sidecar received invalid content");
  const key = artifactKey(paper);
  const files = artifactPaths(key, options);
  await fs.mkdir(path.dirname(files.pdf), { recursive: true });
  const temp = `${files.pdf}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, artifact.buffer, { flag: "wx" });
    await fs.rename(temp, files.pdf);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    const existing = await loadArtifact(paper, options);
    if (!existing) throw error;
  }
  await writeJsonAtomic(files.meta, {
    finalUrl: String(artifact.finalUrl ?? ""),
    byteLength: artifact.buffer.length,
    savedAt: Date.now(),
  });
  return { key, buffer: artifact.buffer, contentType: "application/pdf", finalUrl: String(artifact.finalUrl ?? ""), cached: false };
}

function publicJob(job) {
  if (!job) return null;
  return {
    operationId: job.operationId,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    sources: job.sources,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
  };
}

async function persistJob(job, options = {}) {
  await writeJsonAtomic(manifestPath(job.operationId, options), publicJob(job));
}

export async function getPdfSourceJob(operationId, options = {}) {
  const id = String(operationId ?? "").trim();
  if (!id) return null;
  const memory = jobs.get(id);
  if (memory) return publicJob(memory);
  try {
    const stored = JSON.parse(await fs.readFile(manifestPath(id, options), "utf8"));
    if (stored?.operationId !== id || !Array.isArray(stored.sources)) return null;
    return stored;
  } catch {
    return null;
  }
}

function sourceRecord(paper, sourceIndex, artifact) {
  return {
    ...paper,
    pdfUrl: artifact.finalUrl || String(paper?.pdfUrl ?? ""),
    pdfSourceId: `pdfcache:${artifact.key}`,
    sourceIndex,
    pdfCached: true,
  };
}

/**
 * Start one detached, sequential crawl. It never mutates or filters the search
 * papers used by synthesis; callbacks report only verified, disk-cached PDFs.
 */
export function startPdfSourceCrawl({ operationId, papers, onSourceReady, onProgress, options = {} }) {
  const id = String(operationId ?? "").trim();
  const list = Array.isArray(papers) ? [...papers] : [];
  if (!id || jobs.get(id)?.status === "running") return jobs.get(id)?.promise ?? Promise.resolve(null);
  const job = {
    operationId: id,
    status: "running",
    total: list.length,
    completed: 0,
    failed: 0,
    sources: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
    promise: null,
  };
  jobs.set(id, job);
  const itemTimeoutMs = Math.min(90_000, Math.max(5_000, Number(options.itemTimeoutMs ?? process.env.PDF_SOURCE_ITEM_TIMEOUT_MS) || 35_000));
  const fetchPdf = options.fetchPdf ?? ((paper) => fetchPdfFromSourcesSecurely(paper, {
    resolveOpenAccess: resolveOpenAccessPdfCandidates,
    totalTimeoutMs: itemTimeoutMs,
  }));

  job.promise = (async () => {
    await persistJob(job, options);
    for (let sourceIndex = 0; sourceIndex < list.length; sourceIndex += 1) {
      const paper = list[sourceIndex];
      try {
        let artifact = await loadArtifact(paper, options);
        if (!artifact) {
          const fetched = await fetchPdf(paper, { sourceIndex, total: list.length });
          artifact = await saveArtifact(paper, fetched, options);
        }
        const source = sourceRecord(paper, sourceIndex, artifact);
        job.sources.push(source);
        job.completed += 1;
        job.updatedAt = Date.now();
        await persistJob(job, options);
        onSourceReady?.(source, publicJob(job));
      } catch (error) {
        job.completed += 1;
        job.failed += 1;
        job.updatedAt = Date.now();
        await persistJob(job, options).catch(() => undefined);
        console.warn(`[pdf-sidecar] ${sourceIndex + 1}/${list.length}`, String(error?.message || error).slice(0, 220));
      }
      onProgress?.(publicJob(job));
    }
    job.status = "completed";
    job.updatedAt = Date.now();
    await persistJob(job, options);
    onProgress?.(publicJob(job));
    return publicJob(job);
  })().catch(async (error) => {
    job.status = "failed";
    job.updatedAt = Date.now();
    await persistJob(job, options).catch(() => undefined);
    console.error("[pdf-sidecar] job failed", error?.message || error);
    onProgress?.(publicJob(job));
    return publicJob(job);
  });
  return job.promise;
}

export async function loadCachedPdfSource(operationId, rawSourceId, options = {}) {
  const sourceId = String(rawSourceId ?? "").trim();
  const match = sourceId.match(/^pdfcache:([a-f0-9]{64})$/i);
  if (!match) return null;
  const job = await getPdfSourceJob(operationId, options);
  const source = job?.sources?.find((item) => item?.pdfSourceId === sourceId);
  if (!source) return null;
  const files = artifactPaths(match[1].toLowerCase(), options);
  try {
    const buffer = await fs.readFile(files.pdf);
    if (!isPdf(buffer)) return null;
    return { source, artifact: { buffer, contentType: "application/pdf", finalUrl: String(source.pdfUrl ?? ""), prefetched: true } };
  } catch {
    return null;
  }
}
