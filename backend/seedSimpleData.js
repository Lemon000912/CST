import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { upsertPapers } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
/** 项目内 `backend/data/` 下的单文件（按顺序尝试） */
const SIMPLE_FILE_CANDIDATES = [
  path.join(DATA_DIR, "simple-papers.json"),
  path.join(DATA_DIR, "simple-datas.json"),
  path.join(DATA_DIR, "simple datas.json"),
];
/** 项目根目录下的 `simple datas` 文件夹：仅当 SIMPLE_SEED=1 时读取其中 `.json` */
const SIMPLE_DATAS_DIR = path.join(REPO_ROOT, "simple datas");

function parseJsonToRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.papers)) return raw.papers;
  if (raw && Array.isArray(raw.data)) return raw.data;
  return [];
}

function loadRowsFromJsonFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parseJsonToRows(raw);
}

/** 读取 `simple datas/` 目录下所有 `.json` */
function loadRowsFromSimpleDatasDir() {
  if (!fs.existsSync(SIMPLE_DATAS_DIR)) return [];
  const st = fs.statSync(SIMPLE_DATAS_DIR);
  if (!st.isDirectory()) return [];
  const names = fs
    .readdirSync(SIMPLE_DATAS_DIR)
    .filter((n) => n.toLowerCase().endsWith(".json"))
    .sort();
  const all = [];
  for (const n of names) {
    const fp = path.join(SIMPLE_DATAS_DIR, n);
    try {
      const rows = loadRowsFromJsonFile(fp);
      if (rows.length) {
        all.push(...rows);
        console.log("[seed] 已读入", path.relative(REPO_ROOT, fp), "→", rows.length, "条");
      }
    } catch (e) {
      console.warn("[seed] 跳过", n, String(e?.message || e));
    }
  }
  return all;
}

function normalizeRows(rows, now) {
  return rows.map((r) => ({
    paper_id: String(r.paper_id ?? "").trim(),
    doi: r.doi != null ? String(r.doi).trim() : null,
    title: String(r.title ?? "Untitled").trim() || "Untitled",
    abstract: String(r.abstract ?? ""),
    year: r.year != null ? Number(r.year) : null,
    venue: r.venue != null ? String(r.venue) : null,
    oa_status: r.oa_status != null ? String(r.oa_status) : null,
    arxiv_id: r.arxiv_id != null ? String(r.arxiv_id) : null,
    authors_json: typeof r.authors_json === "string" ? r.authors_json : JSON.stringify(r.authors ?? []),
    abs_url: String(r.abs_url ?? (r.doi ? `https://doi.org/${encodeURIComponent(r.doi)}` : "")),
    pdf_url: String(r.pdf_url ?? (r.doi ? `https://doi.org/${encodeURIComponent(r.doi)}` : "")),
    patentNumber: r.patentNumber ?? r.patent_number ?? null,
    created_at: r.created_at != null ? Number(r.created_at) : now,
  }));
}

/**
 * 可选演示种子：仅当环境变量 `SIMPLE_SEED=1` 时执行。
 * 顺序：`backend/data/` 首个 simple-*.json → `simple datas/*.json`（后者覆盖同 paper_id）。
 */
export async function seedSimplePapersFromJson() {
  const now = Date.now();
  const byPaperId = new Map();

  const singleFile = SIMPLE_FILE_CANDIDATES.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (singleFile) {
    try {
      const rows = loadRowsFromJsonFile(singleFile);
      for (const r of normalizeRows(rows, now)) {
        if (r.paper_id) byPaperId.set(r.paper_id, r);
      }
      console.log("[seed] 已从", path.relative(REPO_ROOT, singleFile), "合并", rows.length, "条");
    } catch (e) {
      console.error("[seed] 读取", singleFile, e);
    }
  }

  const fromDir = loadRowsFromSimpleDatasDir();
  for (const r of normalizeRows(fromDir, now)) {
    if (r.paper_id) byPaperId.set(r.paper_id, r);
  }

  const ok = [...byPaperId.values()];
  if (!ok.length) {
    console.log("[seed] 无 JSON 可导入（需 SIMPLE_SEED=1 且存在 simple-papers.json 或 simple datas/*.json）");
    return;
  }
  await upsertPapers(ok, "simple-seed");
  console.log("[seed] 共写入", ok.length, "条（演示 JSON，paper_id 后者覆盖前者）");
}
