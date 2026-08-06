import fs from "fs";
import os from "os";
import path from "path";
import multer from "multer";

const MAX_EXTRACT_CHARS = 120_000;
export const MAX_UPLOAD_MB = 100;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const ALLOWED_EXT = new Set([
  ".pdf",
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".docx",
  ".docm",
  ".doc",
  ".pptx",
  ".ppsx",
]);

/** 从 pptx（Office Open XML）抽取幻灯片文字 */
async function extractPptxText(buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n));
  names.sort((a, b) => {
    const na = Number((a.match(/slide(\d+)/i) || [])[1] || 0);
    const nb = Number((b.match(/slide(\d+)/i) || [])[1] || 0);
    return na - nb;
  });
  const slides = [];
  for (const name of names) {
    const xml = await zip.file(name).async("string");
    const parts = [];
    for (const m of xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)) {
      const t = m[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim();
      if (t) parts.push(t);
    }
    if (parts.length) slides.push(parts.join(" "));
  }
  return slides.join("\n\n");
}

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
}

function truncate(s) {
  if (s.length <= MAX_EXTRACT_CHARS) return s;
  return `${s.slice(0, MAX_EXTRACT_CHARS)}\n\n…[正文过长，已截断至 ${MAX_EXTRACT_CHARS} 字]`;
}

/**
 * @param {Buffer} buffer
 * @param {string} originalname
 */
export async function extractDocumentText(buffer, originalname) {
  const ext = path.extname(originalname || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`不支持的扩展名「${ext || "无"}」，请使用 pdf、pptx、markdown、txt、doc、docx`);
  }
  if (!buffer?.length) throw new Error("空文件");

  let raw = "";

  if (ext === ".pdf") {
    const mod = await import("pdf-parse");
    const pdfParse = mod.default ?? mod;
    const res = await pdfParse(buffer);
    raw = res?.text ?? "";
  } else if (ext === ".docx" || ext === ".docm") {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer });
    raw = r.value ?? "";
  } else if (ext === ".md" || ext === ".markdown" || ext === ".txt" || ext === ".text") {
    raw = buffer.toString("utf8");
  } else if (ext === ".pptx" || ext === ".ppsx") {
    raw = await extractPptxText(buffer);
  } else if (ext === ".doc") {
    const tmp = path.join(
      os.tmpdir(),
      `pq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.doc`,
    );
    fs.writeFileSync(tmp, buffer);
    try {
      const WordExtractor = (await import("word-extractor")).default;
      const extractor = new WordExtractor();
      const doc = await extractor.extract(tmp);
      raw = doc.getBody() ?? "";
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  const text = truncate(normalizeText(raw));
  if (!text) throw new Error("未能从文件中提取到可读文本");
  return text;
}
