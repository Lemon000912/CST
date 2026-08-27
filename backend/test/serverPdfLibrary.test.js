import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  SERVER_PDF_CATEGORIES,
  normalizeServerPdfRelativePath,
  resolveServerPdfPath,
  serverPdfPaperId,
} from "../serverPdfLibrary.js";

test("server PDF library exposes all ten unique categories including other", () => {
  assert.equal(SERVER_PDF_CATEGORIES.length, 10);
  assert.equal(new Set(SERVER_PDF_CATEGORIES.map((item) => item.code)).size, 10);
  assert.equal(SERVER_PDF_CATEGORIES.some((item) => item.folderName === "\u5176\u4ed6\u7c7b" && item.code === "other"), true);
});

test("server PDF paths stay inside the configured root", () => {
  const root = path.resolve("library-root");
  const file = path.join(root, "category", "paper.pdf");
  assert.equal(normalizeServerPdfRelativePath(root, file), "category/paper.pdf");
  assert.equal(resolveServerPdfPath(root, "category/paper.pdf"), file);
  assert.throws(() => resolveServerPdfPath(root, "../secret.pdf"), /escapes/);
});

test("server PDF paper IDs are stable across path separator and case differences", () => {
  assert.equal(serverPdfPaperId("Category/Paper.PDF"), serverPdfPaperId("category\\paper.pdf"));
  assert.match(serverPdfPaperId("category/paper.pdf"), /^server-pdf:[a-f0-9]{32}$/);
});
