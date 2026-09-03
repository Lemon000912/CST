import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-postgres-upsert-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.POSTGRES_URL = "";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { pgPool, upsertPapers } = await import("../db.js");

test("PostgreSQL paper upsert preserves PDF metadata without opening sql.js", async (t) => {
  t.after(async () => {
    await pgPool.end();
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* no SQLite file should exist */ }
    try { fs.rmSync(`${sqliteFile}.sqljs.lock`, { force: true }); } catch { /* no lock should exist */ }
  });

  const calls = [];
  pgPool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [] };
  };

  await upsertPapers([
    {
      paper_id: "server-pdf:fixture",
      doi: "10.1000/fixture",
      title: "Fixture paper",
      abstract: "Fixture abstract",
      year: 2026,
      venue: "Fixture journal",
      oa_status: "open",
      arxiv_id: "2601.00001",
      authors_json: '["Researcher"]',
      abs_url: "https://example.test/fixture",
      pdf_url: "db-pdf:server-pdf:fixture",
      patent_number: "CN123456A",
    },
  ], "batch:test");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /abs_url, pdf_url, patent_number/);
  assert.match(calls[0].sql, /WHEN papers\.pdf_url LIKE 'db-pdf:%' THEN papers\.pdf_url/);
  assert.equal(calls[0].params[8], "batch:test");
  assert.equal(calls[0].params[13], "https://example.test/fixture");
  assert.equal(calls[0].params[14], "db-pdf:server-pdf:fixture");
  assert.equal(calls[0].params[15], "CN123456A");
  assert.equal(fs.existsSync(sqliteFile), false);
  assert.equal(fs.existsSync(`${sqliteFile}.sqljs.lock`), false);
});
