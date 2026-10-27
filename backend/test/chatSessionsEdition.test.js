import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-chat-editions-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

// Model a database created by the previous release, whose edition CHECK did
// not yet include finance. This verifies startup migration preserves rows.
const initSqlJs = await import("sql.js");
const SQL = await initSqlJs.default();
const legacyDb = new SQL.Database();
legacyDb.run(`CREATE TABLE user_chat_sessions (
  user_id TEXT PRIMARY KEY,
  sessions_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1
)`);
legacyDb.run(`CREATE TABLE user_chat_sessions_by_edition (
  user_id TEXT NOT NULL,
  edition TEXT NOT NULL CHECK (edition IN ('school', 'enterprise')),
  sessions_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, edition)
)`);
legacyDb.run(`INSERT INTO user_chat_sessions_by_edition
  (user_id, edition, sessions_json, updated_at) VALUES (?, ?, ?, ?)`, [
  "legacy-edition-user", "enterprise", '[{"id":"legacy-enterprise"}]', Date.now(),
]);
legacyDb.run(`INSERT INTO user_chat_sessions
  (user_id, sessions_json, updated_at) VALUES (?, ?, ?)`, [
  "merge-user", JSON.stringify([
    { id: "old-only", updatedAt: 150 },
    { id: "shared", title: "old", updatedAt: 100 },
    { id: "already-new", title: "old", updatedAt: 100 },
  ]), 100,
]);
legacyDb.run(`INSERT INTO user_chat_sessions_by_edition
  (user_id, edition, sessions_json, updated_at) VALUES (?, ?, ?, ?)`, [
  "merge-user", "school", JSON.stringify([
    { id: "edition-only", updatedAt: 200 },
    { id: "shared", title: "new", updatedAt: 200 },
  ]), 200,
]);
legacyDb.run(`CREATE TABLE user_chat_session_items (
  user_id TEXT NOT NULL,
  edition TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, edition, session_id)
)`);
legacyDb.run(`INSERT INTO user_chat_session_items
  (user_id, edition, session_id, session_json, updated_at) VALUES (?, ?, ?, ?, ?)`, [
  "merge-user", "school", "already-new", JSON.stringify({ id: "already-new", title: "durable", updatedAt: 300 }), 300,
]);
fs.writeFileSync(sqliteFile, Buffer.from(legacyDb.export()));
legacyDb.close();

const {
  createUserRecord,
  getSqliteDb,
  getUserChatSessions,
  initDatabase,
  saveUserChatSessions,
} = await import("../db.js");

test("chat sessions are isolated by application edition", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });

  await initDatabase();
  const userId = "edition-session-user";
  await createUserRecord(userId, "edition_session_user", "unused");

  assert.equal(
    (await getUserChatSessions("legacy-edition-user", "enterprise"))?.sessionsJson,
    '[{"id":"legacy-enterprise"}]',
  );
  const migratedItems = await getSqliteDb();
  assert.equal(
    (await migratedItems.get(
      "SELECT COUNT(*) AS count FROM user_chat_session_items WHERE user_id = ? AND edition = ?",
      ["legacy-edition-user", "enterprise"],
    ))?.count,
    1,
  );

  const merged = JSON.parse((await getUserChatSessions("merge-user", "school"))?.sessionsJson ?? "[]");
  assert.deepEqual(merged.map((session) => session.id).sort(), ["already-new", "edition-only", "old-only", "shared"]);
  assert.equal(merged.find((session) => session.id === "shared")?.title, "new");
  assert.equal(merged.find((session) => session.id === "already-new")?.title, "durable");

  await initDatabase();
  const mergedAfterRestart = JSON.parse((await getUserChatSessions("merge-user", "school"))?.sessionsJson ?? "[]");
  assert.deepEqual(mergedAfterRestart.map((session) => session.id).sort(), ["already-new", "edition-only", "old-only", "shared"]);

  await saveUserChatSessions(userId, '[{"id":"school"}]', Date.now(), null, "school");
  await saveUserChatSessions(userId, '[{"id":"enterprise"}]', Date.now(), null, "enterprise");
  await saveUserChatSessions(userId, '[{"id":"finance"}]', Date.now(), null, "finance");

  assert.equal((await getUserChatSessions(userId, "school"))?.sessionsJson, '[{"id":"school"}]');
  assert.equal((await getUserChatSessions(userId, "enterprise"))?.sessionsJson, '[{"id":"enterprise"}]');
  assert.equal((await getUserChatSessions(userId, "finance"))?.sessionsJson, '[{"id":"finance"}]');
});

test("stale conditional chat-session writes return the durable server snapshot", async () => {
  const userId = "revision-session-user";
  await createUserRecord(userId, "revision_session_user", "unused");

  const first = await saveUserChatSessions(userId, '[{"id":"first"}]', Date.now(), null, "school");
  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);

  const second = await saveUserChatSessions(userId, '[{"id":"second"}]', Date.now(), first.revision, "school", ["first"]);
  assert.equal(second.ok, true);
  assert.equal(second.revision, 2);

  const stale = await saveUserChatSessions(userId, '[{"id":"stale"}]', Date.now(), first.revision, "school");
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.revision, 2);
  assert.equal(stale.sessions_json, '[{"id":"second"}]');
});

test("chat session items remain isolated by user and edition", async () => {
  const firstUser = "item-isolation-user-a";
  const secondUser = "item-isolation-user-b";
  await createUserRecord(firstUser, "item_isolation_user_a", "unused");
  await createUserRecord(secondUser, "item_isolation_user_b", "unused");

  await saveUserChatSessions(firstUser, '[{"id":"same-session","title":"A"}]', Date.now(), null, "school");
  await saveUserChatSessions(secondUser, '[{"id":"same-session","title":"B"}]', Date.now(), null, "school");
  await saveUserChatSessions(firstUser, '[{"id":"same-session","title":"Finance A"}]', Date.now(), null, "finance");

  const updated = await saveUserChatSessions(firstUser, '[{"id":"same-session","title":"A updated"}]', Date.now(), null, "school");
  assert.equal(updated.ok, true);

  assert.match((await getUserChatSessions(firstUser, "school"))?.sessionsJson ?? "", /"title":"A updated"/);
  assert.match((await getUserChatSessions(secondUser, "school"))?.sessionsJson ?? "", /"title":"B"/);
  assert.match((await getUserChatSessions(firstUser, "finance"))?.sessionsJson ?? "", /"title":"Finance A"/);
});
