import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPageDoi,
  extractPublicPdfLinks,
  fetchPdfFromSourcesSecurely,
  fetchPdfSecurely,
  PdfFulfillmentError,
} from "../pdfFulfillment.js";

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
  await assertRejectedWith("http://198.18.1.108/paper.pdf", "blocked-pdf-source");
});

test("PDF fulfillment rejects URL credentials", async () => {
  await assertRejectedWith("https://user:password@example.com/paper.pdf", "invalid-pdf-source");
});

test("source-page parser extracts public PDF links and DOI metadata", () => {
  const html = `<!doctype html>
    <meta name="citation_doi" content="https://doi.org/10.1234/ABC.567">
    <meta name="citation_pdf_url" content="/articles/42/fulltext">
    <link type="application/pdf" href="/articles/42/alternate">
    <a href="https://repo.example.edu/bitstream/123/456">Download full text</a>`;
  assert.deepEqual(extractPublicPdfLinks(html, "https://journal.example.org/article/42"), [
    "https://journal.example.org/articles/42/fulltext",
    "https://journal.example.org/articles/42/alternate",
    "https://repo.example.edu/bitstream/123/456",
  ]);
  assert.equal(extractPageDoi(html), "10.1234/abc.567");
});

test("source fulfillment follows a landing-page hint and verifies PDF bytes", async () => {
  const calls = [];
  const artifact = await fetchPdfFromSourcesSecurely(
    { absUrl: "https://journal.example.org/article/42" },
    {
      fetchResource: async (url, options) => {
        calls.push({ url, referer: options.referer });
        if (!url.endsWith("paper.pdf")) {
          return {
            buffer: Buffer.from('<meta name="citation_pdf_url" content="/article/42/paper.pdf">'),
            contentType: "text/html",
            finalUrl: url,
          };
        }
        return { buffer: Buffer.from("%PDF-1.7\nverified"), contentType: "application/pdf", finalUrl: url };
      },
    },
  );
  assert.equal(artifact.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.deepEqual(calls, [
    { url: "https://journal.example.org/article/42", referer: "" },
    { url: "https://journal.example.org/article/42/paper.pdf", referer: "https://journal.example.org/article/42" },
  ]);
});

test("source fulfillment can resolve an OA candidate from landing-page DOI", async () => {
  const artifact = await fetchPdfFromSourcesSecurely(
    { absUrl: "https://journal.example.org/article/42" },
    {
      fetchResource: async (url) => url.includes("article/42")
        ? {
            buffer: Buffer.from('<meta name="citation_doi" content="10.1234/example.42">'),
            contentType: "text/html",
            finalUrl: url,
          }
        : { buffer: Buffer.from("%PDF-1.7\nopen access"), contentType: "application/pdf", finalUrl: url },
      resolveOpenAccess: async (doi) => {
        assert.equal(doi, "10.1234/example.42");
        return [{ url: "https://repository.example.edu/example-42.pdf" }];
      },
    },
  );
  assert.equal(artifact.finalUrl, "https://repository.example.edu/example-42.pdf");
});

test("source fulfillment never accepts an HTML page as a PDF", async () => {
  await assert.rejects(
    fetchPdfFromSourcesSecurely(
      { absUrl: "https://journal.example.org/article/42" },
      {
        fetchResource: async (url) => ({
          buffer: Buffer.from(url.endsWith("paper.pdf")
            ? "<!doctype html><title>Access denied</title>"
            : '<meta name="citation_pdf_url" content="/paper.pdf">'),
          contentType: "text/html",
          finalUrl: url,
        }),
      },
    ),
    (error) => error instanceof PdfFulfillmentError && error.code === "public-pdf-not-found",
  );
});
