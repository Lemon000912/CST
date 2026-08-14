import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-recharge-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { createUserRecord, getSqliteDb, initDatabase, withDatabaseTransaction } = await import("../db.js");
const { completeRechargeOrder, RECHARGE_PACKAGE } = await import("../recharge.js");

test("paid recharge credits wallet and ledger exactly once", async (t) => {
  t.after(() => {
    try {
      fs.rmSync(sqliteFile, { force: true });
    } catch {
      // The sql.js process lock is released when this test worker exits.
    }
  });
  await initDatabase();
  const userId = "recharge-test-user";
  await createUserRecord(userId, "recharge_test_user", "not-used-in-this-test");
  const orderId = crypto.randomUUID();
  const orderNo = "RINTEGRATIONTEST0001";
  const now = Date.now();
  await withDatabaseTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO point_recharge_orders
       (id, order_no, user_id, package_id, provider, idempotency_key, amount_fen, point_units,
        status, created_at, updated_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      [orderId, orderNo, userId, RECHARGE_PACKAGE.id, "alipay", "integration-order-1",
        RECHARGE_PACKAGE.amountFen, RECHARGE_PACKAGE.pointUnits, now, now, now + 900_000],
    );
  });

  const first = await completeRechargeOrder({
    provider: "alipay",
    orderNo,
    providerTransactionId: "ALIPAY-INTEGRATION-TRANSACTION-1",
    amountFen: RECHARGE_PACKAGE.amountFen,
  });
  assert.equal(first.replayed, false);
  assert.equal(first.order.status, "paid");
  assert.equal(first.order.billing.balanceUnits, 40_000);

  const replay = await completeRechargeOrder({
    provider: "alipay",
    orderNo,
    providerTransactionId: "ALIPAY-INTEGRATION-TRANSACTION-1",
    amountFen: RECHARGE_PACKAGE.amountFen,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.billing.balanceUnits, 40_000);

  const db = await getSqliteDb();
  const wallet = await db.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [userId]);
  const ledger = await db.all("SELECT * FROM point_ledger WHERE user_id = ? AND entry_type = 'recharge'", [userId]);
  assert.equal(Number(wallet.balance_units), 40_000);
  assert.equal(ledger.length, 1);
  assert.equal(Number(ledger[0].delta_units), RECHARGE_PACKAGE.pointUnits);
  assert.equal(ledger[0].idempotency_key, `recharge:${orderId}`);
});
