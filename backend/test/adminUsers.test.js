import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-admin-users-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const {
  createUserRecord,
  findUserById,
  findUserByPhone,
  getSqliteDb,
  initDatabase,
} = await import("../db.js");
const { AdminUsersError, deleteAdminUser, listAdminUsers } = await import("../adminUsers.js");

test("admin users include phone and permanent deletion purges account data", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });

  await initDatabase();
  await createUserRecord(
    "admin-users-target",
    "admin_users_target",
    "unused-password-hash",
    "target@example.com",
    "13800138000",
  );

  const listed = await listAdminUsers({ search: "13800138000" });
  assert.equal(listed.total, 1);
  assert.equal(listed.users[0].phone, "13800138000");
  assert.equal(listed.users[0].email, "target@example.com");

  const db = await getSqliteDb();
  const now = Date.now();
  await db.run(
    `INSERT INTO user_wechat_identities
     (user_id, openid, unionid, nickname, avatar_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    ["admin-users-target", "openid-target", null, "Target", null, now, now],
  );
  await db.run(
    "INSERT INTO user_skill (user_id, persona_id, favorite_keywords, downloaded_papers, answer_feedback, updated_at) VALUES (?,?,?,?,?,?)",
    ["admin-users-target", "researcher", "keywords", "papers", "feedback", now],
  );
  await db.run(
    "INSERT INTO user_chat_sessions (user_id, sessions_json, updated_at, revision, schema_version) VALUES (?,?,?,?,?)",
    ["admin-users-target", "[]", now, 1, 1],
  );
  await db.run(
    "INSERT INTO query_log (user_id, query, filters, result_count, latency_ms, ts) VALUES (?,?,?,?,?,?)",
    ["admin-users-target", "private query", "{}", 1, 10, now],
  );
  await db.run(
    "INSERT INTO point_operations (id, user_id, operation_type, idempotency_key, request_hash, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ["operation-target", "admin-users-target", "search", "search-target", "request-hash", "completed", now, now],
  );
  await db.run(
    `INSERT INTO point_ledger
     (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ["ledger-target", "admin-users-target", "operation-target", "usage", "usage-target", -20, 19980, "{}", now],
  );

  await deleteAdminUser({ userId: "admin-users-target", adminUserId: "another-admin" });

  assert.equal((await listAdminUsers()).total, 0);
  assert.equal(await findUserById("admin-users-target"), null);
  assert.equal(await findUserByPhone("13800138000"), null);

  const account = await db.get("SELECT id FROM users WHERE id = ?", ["admin-users-target"]);
  assert.equal(account, null);
  for (const tableName of [
    "user_wechat_identities",
    "user_skill",
    "user_chat_sessions",
    "query_log",
    "point_ledger",
    "point_operations",
    "point_wallets",
  ]) {
    const row = await db.get(`SELECT COUNT(*) AS total FROM ${tableName} WHERE user_id = ?`, ["admin-users-target"]);
    assert.equal(Number(row.total), 0, `${tableName} should not retain deleted account data`);
  }

  await createUserRecord("ledger-guard-user", "ledger_guard_user", "unused-password-hash");
  await assert.rejects(
    db.run("DELETE FROM point_ledger WHERE user_id = ?", ["ledger-guard-user"]),
    /point_ledger is immutable/,
    "the immutable ledger trigger must be restored after the purge transaction",
  );
});

test("an administrator cannot delete the account used for the current session", async () => {
  await assert.rejects(
    deleteAdminUser({ userId: "current-admin", adminUserId: "current-admin" }),
    (error) => error instanceof AdminUsersError && error.code === "cannot-delete-current-admin",
  );
});
