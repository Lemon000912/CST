import path from "node:path";

import { PdfFulfillmentError } from "./pdfFulfillment.js";

const DATABASE_PDF_PREFIX = "db-pdf:";
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export function databasePdfPaperId(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value.startsWith(DATABASE_PDF_PREFIX)) return null;
  const paperId = value.slice(DATABASE_PDF_PREFIX.length).trim();
  if (!paperId || paperId.length > 240 || !/^[A-Za-z0-9:_-]+$/.test(paperId)) {
    throw new PdfFulfillmentError("invalid-database-pdf-source", "Stored database PDF source is invalid", 422);
  }
  return paperId;
}

export function databasePdfArtifact(row, options = {}) {
  if (!row) throw new PdfFulfillmentError("database-pdf-not-found", "Database PDF was not found", 404);
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const buffer = Buffer.isBuffer(row.pdf_data) ? row.pdf_data : Buffer.from(row.pdf_data ?? []);
  if (buffer.length > maxBytes) {
    throw new PdfFulfillmentError("pdf-too-large", "Database PDF exceeds the server size limit", 413);
  }
  if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new PdfFulfillmentError("invalid-pdf-content", "Stored database content is not a PDF", 422);
  }
  const filename = path.basename(String(row.filename ?? "paper.pdf").trim()) || "paper.pdf";
  return {
    buffer,
    contentType: "application/pdf",
    finalUrl: `${DATABASE_PDF_PREFIX}${String(row.paper_id ?? "")}`,
    filename,
  };
}
