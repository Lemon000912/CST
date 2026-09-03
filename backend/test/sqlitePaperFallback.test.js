import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-paper-fallback-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { initDatabase, searchLocalPapers, upsertPapers } = await import("../db.js");

test("single-process SQLite fallback keeps searchable PDF metadata", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js may release it at process exit */ }
    try { fs.rmSync(`${sqliteFile}.sqljs.lock`, { force: true }); } catch { /* best-effort test cleanup */ }
  });

  await initDatabase();
  await upsertPapers([
    {
      paper_id: "sqlite:fixture",
      doi: "10.1000/sqlite-fixture",
      title: "SQLite fallback fixture",
      abstract: "Searchable fallback abstract",
      year: 2026,
      venue: "Fixture journal",
      oa_status: "open",
      arxiv_id: "2601.00002",
      authors_json: '["Researcher"]',
      abs_url: "https://example.test/sqlite-fixture",
      pdf_url: "https://example.test/sqlite-fixture.pdf",
      patent_number: "CN654321A",
    },
  ], "batch:sqlite-test");

  const rows = await searchLocalPapers("fallback fixture", 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pdf_url, "https://example.test/sqlite-fixture.pdf");
  assert.equal(rows[0].abs_url, "https://example.test/sqlite-fixture");
  assert.equal(rows[0].patent_number, "CN654321A");
});
