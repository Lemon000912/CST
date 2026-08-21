import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-enterprise-billing-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { createUserRecord, getSqliteDb, initDatabase } = await import("../db.js");
const {
  BillingError,
  beginBillableOperation,
  completeBillableOperation,
  getPointBalance,
  stableRequestHash,
} = await import("../billing.js");

test("enterprise operations can run at zero balance without changing the wallet", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });

  await initDatabase();
  const userId = "enterprise-zero-balance-user";
  await createUserRecord(userId, "enterprise_zero_user", "not-used-in-this-test");
  const db = await getSqliteDb();
  await db.run("UPDATE point_wallets SET balance_units = 0 WHERE user_id = ?", [userId]);

  await assert.rejects(
    beginBillableOperation({
      userId,
      operationType: "search",
      idempotencyKey: "school-zero-balance",
      requestHash: stableRequestHash({ edition: "school", query: "test" }),
    }),
    (error) => error instanceof BillingError && error.code === "insufficient-points",
  );

  const begun = await beginBillableOperation({
    userId,
    operationType: "search",
    idempotencyKey: "enterprise-zero-balance",
    requestHash: stableRequestHash({ edition: "enterprise", query: "test" }),
    allowZeroBalance: true,
  });
  assert.equal(begun.replayed, false);

  const completed = await completeBillableOperation({
    operationId: begun.operation.id,
    userId,
    leaseToken: begun.operation.leaseToken,
    costUnits: 0,
    billingDetails: { edition: "enterprise" },
    result: { papers: [] },
  });
  assert.equal(completed.receipt.costUnits, 0);
  assert.equal(completed.receipt.balanceUnits, 0);
  assert.equal((await getPointBalance(userId)).balanceUnits, 0);
});
