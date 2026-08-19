import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import dotenv from "dotenv";
import pg from "pg";

import { extractDocumentText } from "../backend/extract.js";

dotenv.config();

const CATEGORY_MAP = new Map([
  ["光学与光电子材料", "optical_optoelectronic"],
  ["合金与金属材料", "alloy_metallic"],
  ["固态物理与离子导体", "solid_state_ionic_conductor"],
  ["复合与多相材料", "composite_multiphase"],
  ["纳米与低维材料", "nano_low_dimensional"],
  ["表面与薄膜材料", "surface_thin_film"],
  ["陶瓷与结构材料", "ceramic_structural"],
  ["非晶与玻璃材料", "amorphous_glass"],
  ["高分子与软物质材料", "polymer_soft_matter"],
]);

function option(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function cleanTitle(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/^[A-Za-z]+-\d+\./, "")
    .replace(/^Sci-Hub\.\s*/i, "")
    .replace(/\s+_\s+10\.\d{4,9}.*$/i, "")
    .replace(/\s+_\s+[^_]{1,80},\s*(?:19|20)\d{2}.*$/i, "")
    .replace(/[_\s]+/g, " ")
    .trim()
    .slice(0, 500);
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

function evenlySpaced(items, wanted) {
  if (items.length <= wanted) return items;
  const selected = [];
  for (let index = 0; index < wanted; index += 1) {
    selected.push(items[Math.floor(index * items.length / wanted)]);
  }
  return selected;
}

async function main() {
  const root = path.resolve(option("root", process.env.LOCAL_PDF_IMPORT_ROOT || ""));
  const perCategory = Number.parseInt(option("per-category", "5"), 10);
  const maxBytes = Math.round(Number.parseFloat(option("max-mb", "3")) * 1024 * 1024);
  if (!root || root === path.parse(root).root) throw new Error("请通过 --root=目录 指定 PDF 分类根目录");
  if (!Number.isSafeInteger(perCategory) || perCategory < 1 || perCategory > 100) {
    throw new Error("--per-category 必须是 1 到 100 的整数");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 50_000 || maxBytes > 20 * 1024 * 1024) {
    throw new Error("--max-mb 必须对应 50KB 到 20MB");
  }
  if (!process.env.DATABASE_URL) throw new Error(".env 中未配置 DATABASE_URL");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const existingResult = await pool.query("SELECT sha256 FROM paper_pdf_files");
  const existingHashes = new Set(existingResult.rows.map((row) => String(row.sha256)));
  const report = [];
  let imported = 0;
  let skipped = 0;

  try {
    for (const [folderName, category] of CATEGORY_MAP) {
      const categoryRoot = path.join(root, folderName);
      try {
        await fs.access(categoryRoot);
      } catch {
        report.push({ folderName, category, imported: 0, note: "目录不存在" });
        continue;
      }

      const allFiles = await listPdfs(categoryRoot);
      const candidates = [];
      for (const filePath of allFiles) {
        const stat = await fs.stat(filePath);
        if (stat.size >= 50_000 && stat.size <= maxBytes) candidates.push({ filePath, size: stat.size });
      }
      candidates.sort((left, right) => path.basename(left.filePath).localeCompare(
        path.basename(right.filePath),
        "en",
        { numeric: true, sensitivity: "base" },
      ));

      // Use a wider, evenly distributed candidate pool so duplicate or broken
      // files can be skipped while still filling the requested category count.
      const candidatePool = evenlySpaced(candidates, Math.min(candidates.length, perCategory * 8));
      let categoryImported = 0;
      for (const candidate of candidatePool) {
        if (categoryImported >= perCategory) break;
        const buffer = await fs.readFile(candidate.filePath);
        if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
          skipped += 1;
          continue;
        }
        const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
        if (existingHashes.has(sha256)) {
          skipped += 1;
          continue;
        }

        const filename = path.basename(candidate.filePath);
        const title = cleanTitle(filename) || `本地文献 ${sha256.slice(0, 12)}`;
        const yearMatch = filename.match(/(?:19|20)\d{2}/);
        const paperId = `local-pdf:${sha256.slice(0, 32)}`;
        let abstract = `${folderName}本地 PDF 文献。文件名：${filename}`;
        try {
          const extracted = await extractDocumentText(buffer, filename);
          abstract = extracted.replace(/\s+/g, " ").trim().slice(0, 6000) || abstract;
        } catch {
          // Scanned or malformed text layers still have a usable title and PDF.
        }

        const client = await pool.connect();
        try {
          const now = Date.now();
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO papers (
               paper_id, doi, title, abstract, year, venue, oa_status, source_batch,
               created_at, updated_at, authors_json, pdf_url, category, material_name,
               citation_count, download_count, relevance_score, credibility_score, language, summary
             ) VALUES (
               $1, NULL, $2, $3, $4, $5, 'local', 'local_pdf_import',
               $6, $6, '[]', $7, $8, $9, 0, 0, 100, 100, 'en', $3
             )
             ON CONFLICT (paper_id) DO UPDATE SET
               title = EXCLUDED.title,
               abstract = EXCLUDED.abstract,
               updated_at = EXCLUDED.updated_at,
               pdf_url = EXCLUDED.pdf_url,
               category = EXCLUDED.category,
               material_name = EXCLUDED.material_name,
               summary = EXCLUDED.summary`,
            [
              paperId,
              title,
              abstract,
              yearMatch ? Number(yearMatch[0]) : null,
              folderName,
              now,
              `db-pdf:${paperId}`,
              category,
              folderName,
            ],
          );
          await client.query(
            `INSERT INTO paper_pdf_files (
               paper_id, filename, content_type, byte_length, sha256, pdf_data, created_at, updated_at
             ) VALUES ($1, $2, 'application/pdf', $3, $4, $5, $6, $6)
             ON CONFLICT (paper_id) DO UPDATE SET
               filename = EXCLUDED.filename,
               byte_length = EXCLUDED.byte_length,
               sha256 = EXCLUDED.sha256,
               pdf_data = EXCLUDED.pdf_data,
               updated_at = EXCLUDED.updated_at`,
            [paperId, filename, buffer.length, sha256, buffer, now],
          );
          await client.query("COMMIT");
          existingHashes.add(sha256);
          imported += 1;
          categoryImported += 1;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      report.push({ folderName, category, imported: categoryImported, available: allFiles.length });
    }

    const totalResult = await pool.query(
      "SELECT COUNT(*)::int AS files, COALESCE(SUM(byte_length), 0)::bigint::text AS bytes FROM paper_pdf_files",
    );
    console.log(JSON.stringify({ imported, skipped, total: totalResult.rows[0], categories: report }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
