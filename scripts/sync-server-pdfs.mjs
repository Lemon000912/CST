import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import dotenv from "dotenv";
import pg from "pg";

import {
  SERVER_PDF_CATEGORIES,
  cleanServerPdfTitle,
  normalizeServerPdfRelativePath,
  resolveServerPdfPath,
  serverPdfDoiFromFilename,
  serverPdfPaperId,
} from "../backend/serverPdfLibrary.js";
import { ensureServerPdfSchema } from "../backend/serverPdfSchema.js";

dotenv.config();

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extractorScript = path.join(scriptDirectory, "extract-server-pdf-text.mjs");

function option(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item === undefined ? fallback : item.slice(prefix.length);
}

function integerOption(name, fallback, minimum, maximum) {
  const value = Number.parseInt(option(name, String(fallback)), 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function listPdfs(root) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) found.push(fullPath);
    }
  }
  return found;
}

async function hasPdfSignature(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === 5 && signature.toString("ascii") === "%PDF-";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function fallbackAbstract(folderName, filename) {
  return `${folderName} PDF document. File: ${filename}`;
}

async function indexPdf(client, root, category, filePath, stat, sha256, now, doi) {
  const relativePath = normalizeServerPdfRelativePath(root, filePath);
  const paperId = serverPdfPaperId(relativePath);
  const filename = path.basename(filePath);
  const title = cleanServerPdfTitle(filename) || `PDF ${sha256.slice(0, 12)}`;
  const yearMatch = filename.match(/(?:19|20)\d{2}/);
  const abstract = fallbackAbstract(category.folderName, filename);

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO papers (
         paper_id, doi, title, abstract, year, venue, journal, oa_status, source_batch,
         created_at, updated_at, authors_json, pdf_url, category, material_name,
         citation_count, download_count, relevance_score, credibility_score, language, summary
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'local', 'server_pdf_library',
         $8, $9, '[]', $10, $11, $12, 0, 0, 100, 100, 'unknown', $13
       )
       ON CONFLICT (paper_id) DO UPDATE SET
         doi = COALESCE(EXCLUDED.doi, papers.doi),
         title = EXCLUDED.title,
         year = EXCLUDED.year,
         venue = EXCLUDED.venue,
         journal = EXCLUDED.journal,
         oa_status = EXCLUDED.oa_status,
         source_batch = EXCLUDED.source_batch,
         updated_at = EXCLUDED.updated_at,
         pdf_url = EXCLUDED.pdf_url,
         category = EXCLUDED.category,
         material_name = EXCLUDED.material_name`,
      [
        paperId,
        doi,
        title,
        abstract,
        yearMatch ? Number(yearMatch[0]) : null,
        category.folderName,
        category.folderName,
        now,
        now,
        `db-pdf:${paperId}`,
        category.code,
        category.folderName,
        abstract,
      ],
    );
    await client.query(
      `INSERT INTO paper_pdf_files (
         paper_id, filename, content_type, byte_length, sha256, pdf_data,
         relative_path, storage_kind, file_mtime_ms, file_status, parse_status,
         parse_error, parse_attempts, last_seen_at, created_at, updated_at
       ) VALUES (
         $1, $2, 'application/pdf', $3, $4, NULL,
         $5, 'filesystem', $6, 'active', 'queued', NULL, 0, $7, $7, $7
       )
       ON CONFLICT (paper_id) DO UPDATE SET
         filename = EXCLUDED.filename,
         byte_length = EXCLUDED.byte_length,
         sha256 = EXCLUDED.sha256,
         pdf_data = NULL,
         relative_path = EXCLUDED.relative_path,
         storage_kind = 'filesystem',
         file_mtime_ms = EXCLUDED.file_mtime_ms,
         file_status = 'active',
         parse_status = CASE
           WHEN paper_pdf_files.sha256 = EXCLUDED.sha256 AND paper_pdf_files.parse_status = 'ready'
             THEN 'ready'
           ELSE 'queued'
         END,
         parse_error = CASE WHEN paper_pdf_files.sha256 = EXCLUDED.sha256 THEN paper_pdf_files.parse_error ELSE NULL END,
         parse_attempts = CASE WHEN paper_pdf_files.sha256 = EXCLUDED.sha256 THEN paper_pdf_files.parse_attempts ELSE 0 END,
         last_seen_at = EXCLUDED.last_seen_at,
         updated_at = EXCLUDED.updated_at`,
      [paperId, filename, stat.size, sha256, relativePath, Math.trunc(stat.mtimeMs), now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { paperId, relativePath };
}

async function parseQueuedPdfs(client, root, settings) {
  if (settings.parseBatch === 0) return { ready: 0, failed: 0 };
  const result = await client.query(
    `SELECT paper_id, relative_path
       FROM paper_pdf_files
      WHERE storage_kind = 'filesystem'
        AND file_status = 'active'
        AND parse_status IN ('queued', 'failed')
        AND parse_attempts < $1
      ORDER BY updated_at ASC
      LIMIT $2`,
    [settings.parseRetries, settings.parseBatch],
  );
  let ready = 0;
  let failed = 0;
  for (const row of result.rows) {
    await client.query(
      `UPDATE paper_pdf_files
          SET parse_status = 'processing', parse_attempts = parse_attempts + 1,
              parse_error = NULL, updated_at = $2
        WHERE paper_id = $1`,
      [row.paper_id, Date.now()],
    );
    try {
      const filePath = resolveServerPdfPath(root, row.relative_path);
      const { stdout } = await execFileAsync(
        process.execPath,
        [`--max-old-space-size=${settings.parseMemoryMb}`, extractorScript, filePath],
        { timeout: settings.parseTimeoutSeconds * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      );
      const text = String(stdout ?? "").replace(/\s+/g, " ").trim().slice(0, 120_000);
      if (!text) throw new Error("No readable PDF text was extracted");
      const now = Date.now();
      await client.query("BEGIN");
      try {
        await client.query(
          `UPDATE papers SET abstract = $2, summary = $2, updated_at = $3 WHERE paper_id = $1`,
          [row.paper_id, text, now],
        );
        await client.query(
          `UPDATE paper_pdf_files
              SET parse_status = 'ready', parse_error = NULL, text_extracted_at = $2, updated_at = $2
            WHERE paper_id = $1`,
          [row.paper_id, now],
        );
        await client.query("COMMIT");
        ready += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } catch (error) {
      failed += 1;
      await client.query(
        `UPDATE paper_pdf_files SET parse_status = 'failed', parse_error = $2, updated_at = $3 WHERE paper_id = $1`,
        [row.paper_id, String(error?.message ?? error).slice(0, 1000), Date.now()],
      );
    }
  }
  return { ready, failed };
}

async function runScan(pool, root, settings) {
  const client = await pool.connect();
  let locked = false;
  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext('ailunwen-server-pdf-sync')) AS locked");
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return { skipped: "another sync process holds the database lock" };

    const existingResult = await client.query(
      `SELECT paper_id, relative_path, byte_length, file_mtime_ms, sha256
         FROM paper_pdf_files WHERE storage_kind = 'filesystem'`,
    );
    const byPath = new Map(existingResult.rows.map((row) => [String(row.relative_path), row]));
    const byHash = new Map(existingResult.rows.map((row) => [String(row.sha256), row]));
    const report = { discovered: 0, indexed: 0, unchanged: 0, duplicates: 0, invalid: 0, unstable: 0, errors: 0 };
    const now = Date.now();

    for (const category of SERVER_PDF_CATEGORIES) {
      const categoryRoot = path.join(root, category.folderName);
      let files;
      try {
        files = await listPdfs(categoryRoot);
      } catch (error) {
        if (error?.code === "ENOENT") {
          console.warn(`[pdf-sync] category directory is missing: ${categoryRoot}`);
          continue;
        }
        report.errors += 1;
        console.error(`[pdf-sync] unable to scan ${categoryRoot}:`, error?.message ?? error);
        continue;
      }
      files.sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));
      report.discovered += files.length;
      for (const filePath of files) {
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) continue;
          if (now - stat.mtimeMs < settings.stableSeconds * 1000) {
            report.unstable += 1;
            continue;
          }
          const relativePath = normalizeServerPdfRelativePath(root, filePath);
          const previous = byPath.get(relativePath);
          if (
            previous
            && Number(previous.byte_length) === stat.size
            && Number(previous.file_mtime_ms) === Math.trunc(stat.mtimeMs)
          ) {
            await client.query(
              `UPDATE paper_pdf_files SET last_seen_at = $2, file_status = 'active' WHERE paper_id = $1`,
              [previous.paper_id, now],
            );
            report.unchanged += 1;
            continue;
          }
          if (!(await hasPdfSignature(filePath))) {
            report.invalid += 1;
            continue;
          }
          const sha256 = await sha256File(filePath);
          if (previous && String(previous.sha256) !== sha256) {
            const oldHashRecord = byHash.get(String(previous.sha256));
            if (oldHashRecord && String(oldHashRecord.relative_path) === relativePath) {
              byHash.delete(String(previous.sha256));
            }
          }
          const duplicate = byHash.get(sha256);
          if (duplicate && String(duplicate.relative_path) !== relativePath) {
            report.duplicates += 1;
            continue;
          }
          const doi = serverPdfDoiFromFilename(path.basename(filePath));
          const indexed = await indexPdf(client, root, category, filePath, stat, sha256, now, doi);
          const record = {
            paper_id: indexed.paperId,
            relative_path: indexed.relativePath,
            byte_length: stat.size,
            file_mtime_ms: Math.trunc(stat.mtimeMs),
            sha256,
          };
          byPath.set(indexed.relativePath, record);
          byHash.set(sha256, record);
          report.indexed += 1;
        } catch (error) {
          report.errors += 1;
          console.error(`[pdf-sync] unable to index ${filePath}:`, error?.message ?? error);
        }
      }
    }
    report.parsing = await parseQueuedPdfs(client, root, settings);
    return report;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('ailunwen-server-pdf-sync'))").catch(() => {});
    client.release();
  }
}

async function main() {
  const rootInput = option("root", process.env.LOCAL_PDF_IMPORT_ROOT ?? "").trim();
  if (!rootInput) throw new Error("Set LOCAL_PDF_IMPORT_ROOT or pass --root=/home/ubuntu/papers");
  const root = path.resolve(rootInput);
  if (root === path.parse(root).root) throw new Error("The PDF library root cannot be a filesystem root");
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error(`PDF library root is not a directory: ${root}`);
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    throw new Error("Set DATABASE_URL or POSTGRES_URL for the server PostgreSQL database");
  }
  const settings = {
    stableSeconds: integerOption("stable-seconds", 30, 0, 3600),
    intervalSeconds: integerOption("interval-seconds", 60, 5, 86400),
    parseBatch: integerOption("parse-batch", 2, 0, 100),
    parseRetries: integerOption("parse-retries", 3, 1, 20),
    parseTimeoutSeconds: integerOption("parse-timeout-seconds", 120, 10, 3600),
    parseMemoryMb: integerOption("parse-memory-mb", 384, 128, 4096),
  };
  const watch = process.argv.includes("--watch");
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL });
  try {
    await ensureServerPdfSchema(pool);
    do {
      const startedAt = new Date().toISOString();
      const report = await runScan(pool, root, settings);
      console.log(JSON.stringify({ startedAt, root, ...report }));
      if (watch) await new Promise((resolve) => setTimeout(resolve, settings.intervalSeconds * 1000));
    } while (watch);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[pdf-sync]", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
