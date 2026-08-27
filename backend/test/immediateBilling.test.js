import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-immediate-billing-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { createUserRecord, getSqliteDb, initDatabase } = await import("../db.js");
const {
  beginBillableOperation,
  completeImmediateBillableOperation,
  getBillableOperation,
  getPointBalance,
  stableRequestHash,
} = await import("../billing.js");

test("a cached PDF can be charged while its parent search is still processing", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });

  await initDatabase();
  const userId = "immediate-pdf-user";
  await createUserRecord(userId, "immediate_pdf_user", "not-used-in-this-test");
  const initialBalance = (await getPointBalance(userId)).balanceUnits;

  const search = await beginBillableOperation({
    userId,
    operationType: "search",
    idempotencyKey: "active-search",
    requestHash: stableRequestHash({ query: "lithium battery" }),
  });
  assert.equal(search.operation.status, "processing");

  const requestHash = stableRequestHash({
    parentOperationId: search.operation.id,
    sourceId: "cached-source-1",
  });
  const first = await completeImmediateBillableOperation({
    userId,
    operationType: "pdf",
    idempotencyKey: "cached-pdf-download",
    requestHash,
    costUnits: 20,
    billingDetails: { pdfCount: 1 },
    result: { sourceId: "cached-source-1" },
  });

  assert.equal(first.replayed, false);
  assert.equal(first.operation.status, "completed");
  assert.equal(first.receipt.balanceUnits, initialBalance - 20);
  assert.equal((await getBillableOperation({ operationId: search.operation.id, userId })).status, "processing");

  const replay = await completeImmediateBillableOperation({
    userId,
    operationType: "pdf",
    idempotencyKey: "cached-pdf-download",
    requestHash,
    costUnits: 20,
    billingDetails: { pdfCount: 1 },
    result: { sourceId: "cached-source-1" },
  });
  assert.equal(replay.replayed, true);
  assert.equal((await getPointBalance(userId)).balanceUnits, initialBalance - 20);

  const db = await getSqliteDb();
  const ledger = await db.all("SELECT * FROM point_ledger WHERE operation_id = ?", [first.operation.id]);
  assert.equal(ledger.length, 1);
});
