import test from "node:test";
import assert from "node:assert/strict";
import { fetchPdfSecurely, PdfFulfillmentError } from "../pdfFulfillment.js";

async function assertRejectedWith(input, code) {
  await assert.rejects(
    fetchPdfSecurely(input, { timeoutMs: 100 }),
    (error) => error instanceof PdfFulfillmentError && error.code === code,
  );
}

test("PDF fulfillment rejects non-HTTP source schemes", async () => {
  await assertRejectedWith("file:///etc/passwd", "invalid-pdf-source");
  await assertRejectedWith("data:application/pdf,%25PDF-1.7", "invalid-pdf-source");
});

test("PDF fulfillment blocks localhost and private literal addresses", async () => {
  await assertRejectedWith("http://localhost/paper.pdf", "blocked-pdf-source");
  await assertRejectedWith("http://127.0.0.1/paper.pdf", "blocked-pdf-source");
  await assertRejectedWith("http://169.254.169.254/latest/meta-data", "blocked-pdf-source");
  await assertRejectedWith("http://10.0.0.1/paper.pdf", "blocked-pdf-source");
  await assertRejectedWith("http://[::1]/paper.pdf", "blocked-pdf-source");
});

test("PDF fulfillment rejects URL credentials", async () => {
  await assertRejectedWith("https://user:password@example.com/paper.pdf", "invalid-pdf-source");
});
