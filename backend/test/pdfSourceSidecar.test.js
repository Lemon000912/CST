import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getPdfSourceJob,
  loadCachedPdfSource,
  startPdfSourceCrawl,
} from "../pdfSourceSidecar.js";

test("PDF sidecar processes citations sequentially and publishes only cached successes", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cst-pdf-sidecar-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const operationId = `search-test-${Date.now()}-${Math.random()}`;
  const papers = [0, 1, 2].map((index) => ({
    id: `web:${index}`,
    paper_id: `web:${index}`,
    title: `Source ${index + 1}`,
    summary: `Excerpt ${index + 1}`,
    published: "",
    authors: [],
    pdfUrl: "",
    absUrl: `https://example.org/${index + 1}`,
  }));
  const original = JSON.stringify(papers);
  const fetchOrder = [];
  const readyOrder = [];

  const completed = await startPdfSourceCrawl({
    operationId,
    papers,
    options: {
      cacheDir,
      fetchPdf: async (paper) => {
        fetchOrder.push(paper.id);
        if (paper.id === "web:1") throw new Error("no public PDF");
        return {
          buffer: Buffer.from(`%PDF-1.7\n${paper.id}`),
          contentType: "application/pdf",
          finalUrl: `${paper.absUrl}.pdf`,
        };
      },
    },
    onSourceReady: (source) => readyOrder.push(source.sourceIndex),
  });

  assert.deepEqual(fetchOrder, ["web:0", "web:1", "web:2"]);
  assert.deepEqual(readyOrder, [0, 2]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completed, 3);
  assert.equal(completed.failed, 1);
  assert.deepEqual(completed.sources.map((source) => source.sourceIndex), [0, 2]);
  assert.equal(JSON.stringify(papers), original, "answer source papers must not be mutated");

  const stored = await getPdfSourceJob(operationId, { cacheDir });
  assert.deepEqual(stored.sources.map((source) => source.sourceIndex), [0, 2]);
  const cached = await loadCachedPdfSource(operationId, stored.sources[0].pdfSourceId, { cacheDir });
  assert.equal(cached.artifact.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
});
