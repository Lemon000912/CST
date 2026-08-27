import crypto from "node:crypto";
import path from "node:path";

export const SERVER_PDF_CATEGORIES = Object.freeze([
  Object.freeze({ folderName: "\u5149\u5b66\u4e0e\u5149\u7535\u5b50\u6750\u6599", code: "optical_optoelectronic" }),
  Object.freeze({ folderName: "\u5176\u4ed6\u7c7b", code: "other" }),
  Object.freeze({ folderName: "\u5408\u91d1\u4e0e\u91d1\u5c5e\u6750\u6599", code: "alloy_metallic" }),
  Object.freeze({ folderName: "\u56fa\u6001\u7269\u7406\u4e0e\u79bb\u5b50\u5bfc\u4f53", code: "solid_state_ionic_conductor" }),
  Object.freeze({ folderName: "\u590d\u5408\u4e0e\u591a\u76f8\u6750\u6599", code: "composite_multiphase" }),
  Object.freeze({ folderName: "\u7eb3\u7c73\u4e0e\u4f4e\u7ef4\u6750\u6599", code: "nano_low_dimensional" }),
  Object.freeze({ folderName: "\u8868\u9762\u4e0e\u8584\u819c\u6750\u6599", code: "surface_thin_film" }),
  Object.freeze({ folderName: "\u9676\u74f7\u4e0e\u7ed3\u6784\u6750\u6599", code: "ceramic_structural" }),
  Object.freeze({ folderName: "\u975e\u6676\u4e0e\u73bb\u7483\u6750\u6599", code: "amorphous_glass" }),
  Object.freeze({ folderName: "\u9ad8\u5206\u5b50\u4e0e\u8f6f\u7269\u8d28\u6750\u6599", code: "polymer_soft_matter" }),
]);

export function cleanServerPdfTitle(filename) {
  return path.basename(String(filename ?? ""), path.extname(String(filename ?? "")))
    .replace(/^[A-Za-z]+-\d+\./, "")
    .replace(/^Sci-Hub\.\s*/i, "")
    .replace(/\s+_\s+10\.\d{4,9}.*$/i, "")
    .replace(/\s+_\s+[^_]{1,80},\s*(?:19|20)\d{2}.*$/i, "")
    .replace(/[_\s]+/g, " ")
    .trim()
    .slice(0, 500);
}

export function normalizeServerPdfRelativePath(root, filePath) {
  const resolvedRoot = path.resolve(String(root ?? ""));
  const resolvedFile = path.resolve(String(filePath ?? ""));
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("PDF path escapes LOCAL_PDF_IMPORT_ROOT");
  }
  return relative.split(path.sep).join("/");
}

export function resolveServerPdfPath(root, relativePath) {
  const resolvedRoot = path.resolve(String(root ?? ""));
  const normalized = String(relativePath ?? "").replace(/\\/g, "/").trim();
  if (!resolvedRoot || !normalized || normalized.includes("\0") || path.posix.isAbsolute(normalized)) {
    throw new Error("Stored PDF path is invalid");
  }
  const resolvedFile = path.resolve(resolvedRoot, ...normalized.split("/"));
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Stored PDF path escapes LOCAL_PDF_IMPORT_ROOT");
  }
  return resolvedFile;
}

export function serverPdfPaperId(relativePath) {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/").trim().toLowerCase();
  if (!normalized) throw new Error("relativePath is required");
  return `server-pdf:${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}
