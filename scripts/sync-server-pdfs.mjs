import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
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
import { resolvePrimaryProvider, resolveProviderSlot } from "../backend/llmProviders.js";
import { extractServerPdfMeta } from "../backend/serverPdfMetaExtract.js";
import {
  readMarkdownDigest,
  resolveMineruExecutable,
  runMineruPdf,
} from "../backend/deepPaperMine.js";

dotenv.config();

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extractorScript = path.join(scriptDirectory, "extract-server-pdf-text.mjs");
const metaNerScript = path.join(scriptDirectory, "..", "backend", "scripts", "matsci_pdf_meta_extract.py");
const MAX_ABSTRACT_CHARS = 120_000;
const MAX_PARSE_ERROR_CHARS = 1_000;

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

function parseEngineOption() {
  const value = option(
    "parse-engine",
    String(process.env.PDF_PARSE_ENGINE ?? "mineru").trim().toLowerCase(),
  );
  if (value !== "mineru" && value !== "text") {
    throw new Error("--parse-engine must be 'mineru' or 'text'");
  }
  return value;
}

function parseMetaEngineOption() {
  const value = option(
    "meta-engine",
    String(process.env.PDF_META_ENGINE ?? "ner").trim().toLowerCase(),
  );
  if (value !== "ner" && value !== "llm") {
    throw new Error("--meta-engine must be 'ner' or 'llm'");
  }
  return value;
}

/** 定位 MinerU 可执行文件：MINERU_EXE → 项目内 .venv-mineru → PATH；找不到返回 null。 */
function locateMineruExecutable() {
  const preferred = resolveMineruExecutable();
  if (preferred && preferred !== "mineru" && existsSync(preferred)) return preferred;
  const win = process.platform === "win32";
  const names = win ? ["mineru.exe", "mineru.cmd", "mineru.bat"] : ["mineru"];
  const dirs = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
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
         parse_error, parse_attempts, last_seen_at, created_at, updated_at,
         meta_extract_status
       ) VALUES (
         $1, $2, 'application/pdf', $3, $4, NULL,
         $5, 'filesystem', $6, 'active', 'queued', NULL, 0, $7, $7, $7,
         'queued'
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
      const text = await extractPdfText(filePath, settings);
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
        [row.paper_id, String(error?.message ?? error).slice(0, MAX_PARSE_ERROR_CHARS), Date.now()],
      );
    }
  }
  return { ready, failed };
}

/**
 * 按引擎抽取 PDF 正文。
 * mineru：先调用 MinerU(pipeline) 输出 Markdown；失败或未产出正文时自动回退到
 *         原 pdf-parse 文本抽取（控制台告警），text 也失败才抛错（由调用方统一记 failed/重试）。
 * text：原 pdf-parse 子进程抽取，行为与改前一致。
 */
async function extractPdfText(filePath, settings) {
  if (settings.parseEngine !== "mineru") return extractPdfTextLegacy(filePath, settings);
  try {
    return await extractPdfTextWithMineru(filePath, settings);
  } catch (error) {
    const mineruMessage = String(error?.message ?? error ?? "unknown").slice(0, 300);
    console.warn(
      `[pdf-sync] MinerU failed for ${path.basename(filePath)}, falling back to legacy text extraction: ${mineruMessage}`,
    );
    try {
      return await extractPdfTextLegacy(filePath, settings);
    } catch (legacyError) {
      const textMessage = String(legacyError?.message ?? legacyError ?? "unknown").slice(0, 300);
      throw new Error(`mineru:${mineruMessage} | text:${textMessage}`);
    }
  }
}

/** 原 pdf-parse 子进程抽取，行为与改前一致。 */
async function extractPdfTextLegacy(filePath, settings) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [`--max-old-space-size=${settings.parseMemoryMb}`, extractorScript, filePath],
    { timeout: settings.parseTimeoutSeconds * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
  );
  const text = String(stdout ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ABSTRACT_CHARS);
  if (!text) throw new Error("No readable PDF text was extracted");
  return text;
}

async function extractPdfTextWithMineru(filePath, settings) {
  const mineruOut = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-sync-mineru-"));
  try {
    await runMineruPdf(settings.mineruExe, filePath, mineruOut, settings.parseTimeoutSeconds * 1000);
    const digest = readMarkdownDigest(mineruOut, MAX_ABSTRACT_CHARS);
    const text = digest.trim();
    if (!text) throw new Error("MinerU produced no readable markdown");
    const fullText = await collectMarkdownText(mineruOut);
    const mdPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.md`);
    try {
      await fs.writeFile(mdPath, fullText || text, "utf8");
    } catch (error) {
      console.error(
        `[pdf-sync] failed to write MinerU markdown ${mdPath}: ${String(error?.message ?? error).slice(0, 300)}`,
      );
    }
    return text;
  } finally {
    await fs.rm(mineruOut, { recursive: true, force: true }).catch(() => {});
  }
}

/** 数字感知比较（1 < 2 < 10），用于按页/文件名顺序合并 MinerU 输出的 md。 */
function compareNatural(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true, sensitivity: "base" });
}

/** 递归读取目录下全部 .md，按路径自然排序合并为完整文本（不截断，超长也保留）。 */
async function collectMarkdownText(dir) {
  const found = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(full);
    }
  }
  found.sort(compareNatural);
  const parts = [];
  for (const file of found) parts.push(await fs.readFile(file, "utf8"));
  return parts.join("\n\n");
}

/** 元数据提取所用 LLM：默认 A，可用 PDF_META_PROVIDER=B/C 切换到其他槽位。 */
function resolveMetaProvider() {
  const slot = String(process.env.PDF_META_PROVIDER ?? "").trim().toUpperCase();
  if (!slot || slot === "A") return resolvePrimaryProvider();
  return resolveProviderSlot(slot);
}

/** 定位 MatSciBERT NER 抽取运行环境；任一环节缺失返回 null（由调用方决定是否回退 LLM）。 */
function locateMetaNerSetup() {
  if (!existsSync(metaNerScript)) return null;
  const python =
    String(process.env.MATSCI_META_PYTHON ?? process.env.MATSCI_PYTHON ?? "").trim() ||
    (process.platform === "win32"
      ? (existsSync("E:\\python.exe") ? "E:\\python.exe" : "python")
      : "python3");
  let demoDir = String(process.env.MATSCI_META_DEMO_DIR ?? "").trim();
  if (!demoDir && process.platform === "win32") {
    const candidate = "D:\\workTrace\\end\\MatSciBERT\\matscibert-demo";
    if (existsSync(candidate)) demoDir = candidate;
  }
  if (!demoDir) return null;
  const modelDir =
    String(process.env.MATSCI_META_MODEL_DIR ?? "").trim() || path.join(demoDir, "model", "ner_matscholar");
  if (!existsSync(demoDir) || !existsSync(modelDir)) return null;
  return { script: metaNerScript, python, demoDir, modelDir };
}

/**
 * 批量调用 MatSciBERT NER worker：先等 stdout 的 {"ready":true}，再写入全部行并读取逐行结果。
 * 启动失败/超时/退出码非 0 抛错（由调用方整轮回退）；逐行 ok:false 只代表单篇失败，不抛错。
 *
 * @returns {Promise<Array<{id?: string; ok: boolean; fields?: object; error?: string}>>}
 */
function runNerBatch(setup, rows, settings) {
  return new Promise((resolve, reject) => {
    const child = spawn(setup.python, [setup.script], {
      env: {
        ...process.env,
        MATSCI_META_DEMO_DIR: setup.demoDir,
        MATSCI_META_MODEL_DIR: setup.modelDir,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let ready = false;
    let stdoutBuf = "";
    let stderrBuf = "";
    const results = [];
    const timeoutMs = settings.metaTimeoutSeconds * 1000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      reject(new Error(`MatSciBERT NER worker timed out after ${settings.metaTimeoutSeconds}s`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(results);
    };
    child.stderr?.on("data", (chunk) => {
      stderrBuf += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += String(chunk);
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = String(line).trim();
        if (!trimmed) continue;
        let job;
        try {
          job = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!ready) {
          if (job?.ready === true) {
            ready = true;
            const payload = rows
              .map((row) => JSON.stringify({ id: row.paper_id, text: String(row.text ?? "") }))
              .join("\n");
            child.stdin.write(`${payload}\n`, () => {
              try {
                child.stdin.end();
              } catch {}
            });
          } else {
            finish(new Error(String(job?.error || "MatSciBERT NER worker startup failed")));
            try {
              child.stdin.end();
              child.kill();
            } catch {}
            return;
          }
        } else {
          results.push(job);
        }
      }
    });
    child.on("error", (error) => {
      finish(new Error(`failed to start MatSciBERT NER worker: ${error?.message ?? error}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      if (!ready) {
        finish(
          new Error(
            `MatSciBERT NER worker exited before ready (code ${code}): ${stderrBuf.trim().slice(-1500) || "no stderr"}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            `MatSciBERT NER worker exited with code ${code}: ${stderrBuf.trim().slice(-1500) || "no stderr"}`,
          ),
        );
        return;
      }
      finish(null);
    });
  });
}

/** 选取待做元数据提取的行（needs：parse ready + attempts < retries + queued；--meta-refresh 放开 queued 限制）。 */
async function selectMetaRows(client, settings) {
  const statusCondition = settings.metaRefresh
    ? "AND COALESCE(f.meta_extract_status, '') NOT IN ('failed', 'skipped')"
    : "AND f.meta_extract_status = 'queued'";
  return client.query(
    `SELECT f.paper_id, p.title, p.doi, p.abstract AS text
       FROM paper_pdf_files f
       JOIN papers p ON p.paper_id = f.paper_id
      WHERE f.storage_kind = 'filesystem'
        AND f.file_status = 'active'
        AND f.parse_status = 'ready'
        AND f.text_extracted_at IS NOT NULL
        AND f.meta_extract_attempts < $1
        ${statusCondition}
      ORDER BY f.updated_at ASC
      LIMIT $2`,
    [settings.metaRetries, settings.metaBatch],
  );
}

/** 无可用引擎时把本轮 queued 行标记 skipped（沿用原有 no-llm-key 语义）。 */
async function skipQueuedMetaRows(client, errorText) {
  await client.query(
    `UPDATE paper_pdf_files
        SET meta_extract_status = 'skipped', meta_extract_error = $2, updated_at = $1
      WHERE storage_kind = 'filesystem'
        AND file_status = 'active'
        AND parse_status = 'ready'
        AND text_extracted_at IS NOT NULL
        AND meta_extract_status = 'queued'`,
    [Date.now(), errorText],
  );
}

/** 单篇抽取成功：写四个字段 + 置 ready（--meta-refresh 直接覆盖，否则保留已有非空值）。 */
async function applyMetaSuccess(client, row, data, settings) {
  const now = Date.now();
  await client.query("BEGIN");
  try {
    const fieldSet = settings.metaRefresh
      ? "symmetry_phase = $2, synthesis_method = $3, structure_descriptor = $4, properties = $5"
      : "symmetry_phase = COALESCE(NULLIF(btrim(symmetry_phase), ''), $2),"
        + " synthesis_method = COALESCE(NULLIF(btrim(synthesis_method), ''), $3),"
        + " structure_descriptor = COALESCE(NULLIF(btrim(structure_descriptor), ''), $4),"
        + " properties = COALESCE(NULLIF(btrim(properties), ''), $5)";
    await client.query(
      `UPDATE papers SET ${fieldSet}, updated_at = $6 WHERE paper_id = $1`,
      [
        row.paper_id,
        data.symmetry_phase ?? null,
        data.synthesis_method ?? null,
        data.structure_descriptor ?? null,
        data.properties ?? null,
        now,
      ],
    );
    await client.query(
      `UPDATE paper_pdf_files
          SET meta_extract_status = 'ready', meta_extract_error = NULL,
              meta_extracted_at = $2, updated_at = $2
        WHERE paper_id = $1`,
      [row.paper_id, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** 单篇抽取失败：attempts +1；达到上限置 failed，否则保留 queued 供下次重试。 */
async function applyMetaFailure(client, row, error, settings) {
  await client.query(
    `UPDATE paper_pdf_files
        SET meta_extract_attempts = meta_extract_attempts + 1,
            meta_extract_error = $2,
            meta_extract_status = CASE
              WHEN meta_extract_attempts + 1 >= $3 THEN 'failed'
              ELSE 'queued'
            END,
            updated_at = $4
      WHERE paper_id = $1`,
    [row.paper_id, String(error?.message ?? error).slice(0, 1000), settings.metaRetries, Date.now()],
  );
}

/** LLM 引擎：逐篇调用在线大模型，行为与改前完全一致。 */
async function extractPaperMetadataWithLlm(client, settings, provider) {
  const counts = { ready: 0, failed: 0, skipped: 0, noProvider: 0 };
  const result = await selectMetaRows(client, settings);
  for (const row of result.rows) {
    try {
      const outcome = await extractServerPdfMeta({
        provider,
        title: row.title,
        doi: row.doi,
        text: row.text,
      });
      if (!outcome.ok) throw new Error(outcome.error ?? "meta_extract_failed");
      await applyMetaSuccess(client, row, outcome.data, settings);
      counts.ready += 1;
    } catch (error) {
      counts.failed += 1;
      await applyMetaFailure(client, row, error, settings);
    }
  }
  return counts;
}

/** NER 引擎：整批交给本地 MatSciBERT worker；worker 启动失败整轮回退，单篇失败按重试语义记录。 */
async function extractPaperMetadataWithNer(client, settings, setup) {
  const counts = { ready: 0, failed: 0, skipped: 0, noProvider: 0 };
  const result = await selectMetaRows(client, settings);
  if (!result.rows.length) return counts;
  const startedAt = Date.now();
  let outputs;
  try {
    outputs = await runNerBatch(setup, result.rows, settings);
  } catch (error) {
    return {
      fallbackToLlm: true,
      message: String(error?.message ?? error).slice(0, 500),
      counts,
    };
  }
  const byId = new Map(
    (Array.isArray(outputs) ? outputs : [])
      .filter((item) => item && item.id !== undefined && item.id !== null)
      .map((item) => [String(item.id), item]),
  );
  for (const row of result.rows) {
    const output = byId.get(String(row.paper_id));
    try {
      if (!output) throw new Error("ner:no-output");
      if (!output.ok) throw new Error(String(output.error || "ner_extract_failed"));
      await applyMetaSuccess(client, row, output.fields ?? {}, settings);
      counts.ready += 1;
    } catch (error) {
      counts.failed += 1;
      await applyMetaFailure(client, row, error, settings);
    }
  }
  counts.nerElapsedMs = Date.now() - startedAt;
  return counts;
}

/**
 * 元数据提取阶段：复用 papers.abstract 中已抽取的正文，提取
 * symmetry_phase / synthesis_method / structure_descriptor / properties。
 * PDF_META_ENGINE / --meta-engine：ner（默认，本地 MatSciBERT NER）或 llm（在线大模型，原逻辑）。
 * ner 引擎启动环境缺失或整批失败时告警后整轮回退 llm（镜像 MinerU 缺失时降级 text）；无 LLM key 则标记 skipped。
 * 只处理「新入库文件」（indexPdf 插入时 meta_extract_status='queued' 的行），
 * 历史数据（meta_extract_status 为 NULL）不触碰；--meta-refresh 显式强制重跑可覆盖。
 */
async function extractPaperMetadata(client, settings) {
  const counts = { ready: 0, failed: 0, skipped: 0, noProvider: 0, engine: settings.metaEngine };
  if (settings.metaBatch === 0) return counts;

  const setup = settings.metaEngine === "ner" ? locateMetaNerSetup() : null;
  if (settings.metaEngine === "ner" && !setup) {
    counts.engine = "llm";
    console.warn(
      "[pdf-sync] PDF_META_ENGINE=ner but MatSciBERT NER setup was not found " +
        "(MATSCI_META_PYTHON / MATSCI_META_DEMO_DIR / MATSCI_META_MODEL_DIR / backend/scripts/matsci_pdf_meta_extract.py); " +
        "falling back to LLM engine for this run",
    );
  }

  if (!setup) {
    const provider = resolveMetaProvider();
    if (!provider) {
      await skipQueuedMetaRows(client, "no-llm-key");
      counts.noProvider = 1;
      console.warn("[pdf-sync] no LLM provider configured; pending metadata rows marked as skipped");
      return counts;
    }
    return extractPaperMetadataWithLlm(client, settings, provider);
  }

  const outcome = await extractPaperMetadataWithNer(client, settings, setup);
  if (!outcome.fallbackToLlm) {
    return {
      ...counts,
      ready: outcome.ready,
      failed: outcome.failed,
      skipped: outcome.skipped,
      nerElapsedMs: outcome.nerElapsedMs,
    };
  }

  console.warn(
    `[pdf-sync] MatSciBERT NER batch failed, falling back to LLM engine for this run: ${outcome.message ?? "unknown"}`,
  );
  const provider = resolveMetaProvider();
  if (!provider) {
    await skipQueuedMetaRows(client, "ner-unavailable-no-llm-key");
    counts.noProvider = 1;
    counts.engine = "ner->skipped";
    return counts;
  }
  const llmCounts = await extractPaperMetadataWithLlm(client, settings, provider);
  counts.engine = "ner->llm";
  return { ...counts, ...llmCounts };
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
    report.metadata = await extractPaperMetadata(client, settings);
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
  const parseEngine = parseEngineOption();
  const mineruExe = parseEngine === "mineru" ? locateMineruExecutable() : null;
  if (parseEngine === "mineru" && !mineruExe) {
    console.warn(
      "[pdf-sync] PDF_PARSE_ENGINE=mineru but MinerU executable was not found (MINERU_EXE / .venv-mineru / PATH); falling back to legacy text extraction for this run",
    );
  }
  const settings = {
    stableSeconds: integerOption("stable-seconds", 30, 0, 3600),
    intervalSeconds: integerOption("interval-seconds", 60, 5, 86400),
    parseEngine: mineruExe ? "mineru" : "text",
    mineruExe,
    parseBatch: integerOption("parse-batch", 2, 0, 100),
    parseRetries: integerOption("parse-retries", 3, 1, 20),
    parseTimeoutSeconds: integerOption("parse-timeout-seconds", mineruExe ? 600 : 120, 10, 3600),
    parseMemoryMb: integerOption("parse-memory-mb", 384, 128, 4096),
    metaBatch: integerOption("meta-batch", 1, 0, 100),
    metaRetries: integerOption("meta-retries", 2, 1, 20),
    metaEngine: parseMetaEngineOption(),
    metaTimeoutSeconds: integerOption("meta-timeout-seconds", 1800, 30, 7200),
    metaRefresh: process.argv.includes("--meta-refresh"),
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
