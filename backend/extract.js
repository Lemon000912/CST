import fs from "fs";
import os from "os";
import path from "path";
import multer from "multer";

const MAX_EXTRACT_CHARS = 120_000;
export const MAX_UPLOAD_MB = 100;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** Busboy exposes raw UTF-8 multipart filename bytes as Latin-1 on some clients. */
export function normalizeUploadedFilename(value) {
  const filename = String(value ?? "");
  if (!filename || [...filename].some((character) => character.charCodeAt(0) > 0xff)) return filename;
  try {
    const bytes = Buffer.from(filename, "latin1");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded || filename;
  } catch {
    // Preserve legacy filenames encoded using a single-byte charset.
    return filename;
  }
}

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
  ".xlsx",
  ".xlsm",
  ".csv",
  ".tsv",
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

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([\da-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`))?.[1] ?? "";
}

function columnIndex(cellRef) {
  const letters = String(cellRef ?? "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let index = 0;
  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

function xmlTextRuns(xml) {
  return [...String(xml ?? "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

/** Extract workbook cell values in sheet/row order, preserving each row as TSV. */
async function extractXlsxText(buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.values(zip.files).filter((file) => !file.dir);
  const expandedBytes = files.reduce((sum, file) => sum + Number(file._data?.uncompressedSize ?? 0), 0);
  if (files.length > 10_000 || expandedBytes > 150 * 1024 * 1024) {
    throw new Error("表格内容过大，无法安全解析");
  }

  const sharedStringsFile = zip.file("xl/sharedStrings.xml");
  const sharedStrings = sharedStringsFile
    ? [...(await sharedStringsFile.async("string")).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) =>
        xmlTextRuns(match[1]),
      )
    : [];

  let sheets = [];
  const workbookFile = zip.file("xl/workbook.xml");
  const relationshipsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (workbookFile && relationshipsFile) {
    const workbookXml = await workbookFile.async("string");
    const relationshipsXml = await relationshipsFile.async("string");
    const relationshipTargets = new Map(
      [...relationshipsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].map((match) => [
        xmlAttribute(match[0], "Id"),
        xmlAttribute(match[0], "Target"),
      ]),
    );
    sheets = [...workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/g)].flatMap((match) => {
      const tag = match[0];
      const target = relationshipTargets.get(xmlAttribute(tag, "r:id"));
      if (!target) return [];
      const sheetPath = path.posix.normalize(path.posix.join("xl", target.replace(/^\//, "")));
      const normalizedPath = target.startsWith("/") ? target.slice(1) : sheetPath;
      return [{ name: decodeXml(xmlAttribute(tag, "name")), path: normalizedPath }];
    });
  }
  if (!sheets.length) {
    sheets = files
      .map((file) => file.name)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1] ?? 0) - Number(b.match(/sheet(\d+)/i)?.[1] ?? 0))
      .map((sheetPath, index) => ({ name: `工作表${index + 1}`, path: sheetPath }));
  }

  const output = [];
  for (const sheet of sheets) {
    const file = zip.file(sheet.path);
    if (!file) continue;
    const xml = await file.async("string");
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
        const attributes = cellMatch[1] ?? cellMatch[3] ?? "";
        const body = cellMatch[2] ?? "";
        const cellType = xmlAttribute(attributes, "t");
        const value = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
        let text = "";
        if (cellType === "s" && value != null) text = sharedStrings[Number(value)] ?? "";
        else if (cellType === "inlineStr") text = xmlTextRuns(body.match(/<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/)?.[1] ?? body);
        else if (cellType === "str" || cellType === "e" || value != null) text = decodeXml(value ?? "");
        const index = columnIndex(xmlAttribute(attributes, "r"));
        cells[index] = text;
      }
      while (cells.length && !cells.at(-1)) cells.pop();
      if (cells.length) rows.push(cells.map((cell) => String(cell ?? "").replace(/[\t\r\n]+/g, " ")).join("\t"));
    }
    if (rows.length) output.push(`【工作表：${sheet.name || "未命名"}】\n${rows.join("\n")}`);
  }
  return output.join("\n\n");
}

export const uploadMiddleware = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_req, file, cb) => cb(null, `pq-upload-${Date.now()}-${Math.random().toString(36).slice(2,10)}${path.extname(file.originalname || "")}`) }),
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
  const filename = normalizeUploadedFilename(originalname);
  const ext = path.extname(filename || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`不支持的扩展名「${ext || "无"}」，请使用 pdf、pptx、xlsx、csv、tsv、markdown、txt、doc、docx`);
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
  } else if (ext === ".xlsx" || ext === ".xlsm") {
    raw = await extractXlsxText(buffer);
  } else if (ext === ".csv" || ext === ".tsv") {
    raw = buffer.toString("utf8");
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
