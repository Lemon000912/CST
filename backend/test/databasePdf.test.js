import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { databasePdfArtifact, databasePdfPaperId } from "../databasePdf.js";
import { PdfFulfillmentError } from "../pdfFulfillment.js";

test("database PDF URLs are explicit and stored PDF bytes are validated", async () => {
  assert.equal(databasePdfPaperId("https://example.com/paper.pdf"), null);
  assert.equal(databasePdfPaperId("db-pdf:demo-pdf:abc_123"), "demo-pdf:abc_123");
  assert.throws(
    () => databasePdfPaperId("db-pdf:../../secret"),
    (error) => error instanceof PdfFulfillmentError && error.code === "invalid-database-pdf-source",
  );

  const artifact = await databasePdfArtifact({
    paper_id: "demo-pdf:abc_123",
    filename: "demo.pdf",
    pdf_data: Buffer.from("%PDF-1.7\nfixture", "ascii"),
  });
  assert.equal(artifact.filename, "demo.pdf");
  assert.equal(artifact.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  await assert.rejects(
    databasePdfArtifact({ paper_id: "bad", filename: "bad.pdf", pdf_data: Buffer.from("not pdf") }),
    (error) => error instanceof PdfFulfillmentError && error.code === "invalid-pdf-content",
  );
});

test("server PDF artifacts resolve inside the configured root without loading the file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "server-pdf-"));
  try {
    const category = path.join(root, "category");
    await fs.mkdir(category);
    const filePath = path.join(category, "large.pdf");
    await fs.writeFile(filePath, Buffer.from("%PDF-1.7\nfilesystem fixture", "ascii"));
    const artifact = await databasePdfArtifact(
      {
        paper_id: "server-pdf:abc",
        filename: "large.pdf",
        pdf_data: null,
        relative_path: "category/large.pdf",
      },
      { root },
    );
    assert.equal(artifact.filePath, filePath);
    assert.equal(artifact.buffer, undefined);
    assert.equal(artifact.byteLength, 27);

    await assert.rejects(
      databasePdfArtifact(
        { paper_id: "server-pdf:bad", filename: "bad.pdf", pdf_data: null, relative_path: "../bad.pdf" },
        { root },
      ),
      (error) => error instanceof PdfFulfillmentError && error.code === "invalid-database-pdf-source",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
