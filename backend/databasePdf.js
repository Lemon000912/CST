import path from "node:path";
import fs from "node:fs/promises";

import { PdfFulfillmentError } from "./pdfFulfillment.js";
import { resolveServerPdfPath } from "./serverPdfLibrary.js";

const DATABASE_PDF_PREFIX = "db-pdf:";

export function databasePdfPaperId(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value.startsWith(DATABASE_PDF_PREFIX)) return null;
  const paperId = value.slice(DATABASE_PDF_PREFIX.length).trim();
  if (!paperId || paperId.length > 240 || !/^[A-Za-z0-9:_-]+$/.test(paperId)) {
    throw new PdfFulfillmentError("invalid-database-pdf-source", "Stored database PDF source is invalid", 422);
  }
  return paperId;
}

export async function databasePdfArtifact(row, options = {}) {
  if (!row) throw new PdfFulfillmentError("database-pdf-not-found", "Database PDF was not found", 404);
  const buffer = Buffer.isBuffer(row.pdf_data) ? row.pdf_data : Buffer.from(row.pdf_data ?? []);
  const filename = path.basename(String(row.filename ?? "paper.pdf").trim()) || "paper.pdf";
  if (buffer.length > 0) {
    if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new PdfFulfillmentError("invalid-pdf-content", "Stored database content is not a PDF", 422);
    }
    return {
      buffer,
      byteLength: buffer.length,
      contentType: "application/pdf",
      finalUrl: `${DATABASE_PDF_PREFIX}${String(row.paper_id ?? "")}`,
      filename,
    };
  }

  const root = String(options.root ?? process.env.LOCAL_PDF_IMPORT_ROOT ?? "").trim();
  if (!root || !row.relative_path) {
    throw new PdfFulfillmentError("database-pdf-not-found", "Database PDF file is not available", 404);
  }
  let filePath;
  try {
    filePath = resolveServerPdfPath(root, row.relative_path);
  } catch {
    throw new PdfFulfillmentError("invalid-database-pdf-source", "Stored database PDF path is invalid", 422);
  }
  let handle;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    handle = await fs.open(filePath, "r");
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== 5 || signature.toString("ascii") !== "%PDF-") {
      throw new PdfFulfillmentError("invalid-pdf-content", "Stored server file is not a PDF", 422);
    }
    return {
      filePath,
      byteLength: stat.size,
      contentType: "application/pdf",
      finalUrl: `${DATABASE_PDF_PREFIX}${String(row.paper_id ?? "")}`,
      filename,
    };
  } catch (error) {
    if (error instanceof PdfFulfillmentError) throw error;
    throw new PdfFulfillmentError("database-pdf-not-found", "Database PDF file is not available", 404);
  } finally {
    await handle?.close().catch(() => {});
  }
}
