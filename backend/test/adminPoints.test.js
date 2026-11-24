import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-admin-points-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { createUserRecord, getSqliteDb, initDatabase } = await import("../db.js");
const {
  AdminPointsError,
  adjustAdminUserPoints,
  listAdminPointLedger,
  listAdminPointUsers,
  parseAdminPointAmount,
} = await import("../adminPoints.js");

test("admin point amount parser preserves the 0.05 minimum unit", () => {
  assert.equal(parseAdminPointAmount("0.05"), 1);
  assert.equal(parseAdminPointAmount("100"), 2000);
  assert.equal(parseAdminPointAmount("12.50"), 250);
  assert.equal(parseAdminPointAmount("0", { allowZero: true }), 0);
  assert.throws(() => parseAdminPointAmount("0.01"), AdminPointsError);
  assert.throws(() => parseAdminPointAmount("0"), AdminPointsError);
});

test("admin adjustments update the wallet atomically and append audit ledger entries", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });
  await initDatabase();
  const userId = "admin-points-user";
  await createUserRecord(userId, "admin_points_user", "not-used-in-this-test");
  const admin = { userId: "admin-id", username: "admin" };

  const added = await adjustAdminUserPoints({
    userId, mode: "add", amount: "100", reason: "客服补偿", idempotencyKey: "adjust-add-0001", admin,
  });
  assert.equal(added.entry.deltaUnits, 2000);
  assert.equal(added.entry.balanceAfter, "1100.00");
  assert.equal(added.entry.operator, "admin");

  const replay = await adjustAdminUserPoints({
    userId, mode: "add", amount: "100", reason: "客服补偿", idempotencyKey: "adjust-add-0001", admin,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.entry.balanceAfter, "1100.00");

  const deducted = await adjustAdminUserPoints({
    userId, mode: "deduct", amount: "50.25", reason: "异常订单修正", idempotencyKey: "adjust-deduct-0001", admin,
  });
  assert.equal(deducted.entry.deltaUnits, -1005);
  assert.equal(deducted.entry.balanceAfter, "1049.75");

  const set = await adjustAdminUserPoints({
    userId, mode: "set", amount: "12.50", reason: "余额校准", idempotencyKey: "adjust-set-0001", admin,
  });
  assert.equal(set.entry.balanceAfterUnits, 250);
  assert.equal(set.entry.balanceAfter, "12.50");

  const db = await getSqliteDb();
  const wallet = await db.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [userId]);
  assert.equal(Number(wallet.balance_units), 250);
  const adminLedger = await db.all("SELECT * FROM point_ledger WHERE user_id = ? AND entry_type = 'admin_adjustment'", [userId]);
  assert.equal(adminLedger.length, 3, "idempotent replay must not append a second ledger row");

  const listed = await listAdminPointUsers({ search: "admin_points", limit: 10 });
  assert.equal(listed.total, 1);
  assert.equal(listed.users[0].balance, "12.50");
  const ledger = await listAdminPointLedger({ userId, limit: 10 });
  assert.equal(ledger[0].reason, "余额校准");

  // 游客临时账户及 0 积分流水不应污染积分账户列表、预警计数和流水报表
  const guestId = "trial-00000000-0000-4000-8000-000000000002";
  const now = Date.now();
  await db.run(
    "INSERT INTO users (id, username, password_hash, created_at, edition) VALUES (?,?,?,?,?)",
    [guestId, guestId, "!", now, "school"],
  );
  await db.run(
    "INSERT INTO point_wallets (user_id, balance_units, created_at, updated_at) VALUES (?,0,?,?)",
    [guestId, now, now],
  );
  await db.run(
    `INSERT INTO point_ledger
     (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
     VALUES (?,?,NULL,'debit',?,?,?,?,?)`,
    ["guest-ledger-0001", guestId, "operation:guest-op-1", 0, 0, JSON.stringify({ edition: "school" }), now],
  );

  const allUsers = await listAdminPointUsers({ limit: 50 });
  assert.equal(allUsers.total, 1);
  assert.equal(allUsers.summary.walletCount, 1);
  assert.equal(allUsers.summary.attentionCount, 1);
  assert.ok(allUsers.users.every((u) => !u.id.startsWith("trial-")));
  const emptyUsers = await listAdminPointUsers({ status: "empty", limit: 50 });
  assert.equal(emptyUsers.total, 0);
  const allLedger = await listAdminPointLedger({ limit: 50 });
  assert.ok(allLedger.every((entry) => !entry.userId.startsWith("trial-")));
  await assert.rejects(
    adjustAdminUserPoints({
      userId: guestId, mode: "add", amount: "10", reason: "误操作测试", idempotencyKey: "adjust-guest-0001", admin,
    }),
    (error) => error instanceof AdminPointsError && error.code === "guest-account-not-adjustable",
  );
});
