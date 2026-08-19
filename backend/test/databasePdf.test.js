import assert from "node:assert/strict";
import test from "node:test";

import { databasePdfArtifact, databasePdfPaperId } from "../databasePdf.js";
import { PdfFulfillmentError } from "../pdfFulfillment.js";

test("database PDF URLs are explicit and stored PDF bytes are validated", () => {
  assert.equal(databasePdfPaperId("https://example.com/paper.pdf"), null);
  assert.equal(databasePdfPaperId("db-pdf:demo-pdf:abc_123"), "demo-pdf:abc_123");
  assert.throws(
    () => databasePdfPaperId("db-pdf:../../secret"),
    (error) => error instanceof PdfFulfillmentError && error.code === "invalid-database-pdf-source",
  );

  const artifact = databasePdfArtifact({
    paper_id: "demo-pdf:abc_123",
    filename: "demo.pdf",
    pdf_data: Buffer.from("%PDF-1.7\nfixture", "ascii"),
  });
  assert.equal(artifact.filename, "demo.pdf");
  assert.equal(artifact.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.throws(
    () => databasePdfArtifact({ paper_id: "bad", filename: "bad.pdf", pdf_data: Buffer.from("not pdf") }),
    (error) => error instanceof PdfFulfillmentError && error.code === "invalid-pdf-content",
  );
});
