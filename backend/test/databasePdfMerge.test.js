import assert from "node:assert/strict";
import test from "node:test";

import { sourceTier } from "../paperRecommendFilter.js";
import { mergeDedupe } from "../searchService.js";

test("an exact-title external record keeps the database PDF and local identity", () => {
  const title = "Experimental investigation on effect of TIG welding process on chromoly 4130 and aluminum 7075-T6";
  const external = {
    paper_id: "crossref:external",
    doi: "10.1000/external",
    title,
    source: "crossref",
    pdfUrl: "https://doi.org/10.1000/external",
  };
  const database = {
    paper_id: "demo-pdf:local",
    doi: "10.1000/local",
    title,
    source: "local",
    pdfUrl: "db-pdf:demo-pdf:local",
  };

  const [paper] = mergeDedupe([[external], [database]]);
  assert.equal(paper.paper_id, database.paper_id);
  assert.equal(paper.source, "local");
  assert.equal(paper.pdfUrl, database.pdfUrl);
});

test("database PDF records rank above external index records", () => {
  assert.ok(
    sourceTier({ source: "local", pdfUrl: "db-pdf:demo-pdf:local" })
      > sourceTier({ source: "scopus", pdfUrl: "https://example.com/paper.pdf" }),
  );
});
