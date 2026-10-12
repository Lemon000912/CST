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
fs.writeFileSync(sqliteFile, Buffer.from(legacyDb.export()));
legacyDb.close();

const {
  createUserRecord,
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

  await saveUserChatSessions(userId, '[{"id":"school"}]', Date.now(), null, "school");
  await saveUserChatSessions(userId, '[{"id":"enterprise"}]', Date.now(), null, "enterprise");
  await saveUserChatSessions(userId, '[{"id":"finance"}]', Date.now(), null, "finance");

  assert.equal((await getUserChatSessions(userId, "school"))?.sessionsJson, '[{"id":"school"}]');
  assert.equal((await getUserChatSessions(userId, "enterprise"))?.sessionsJson, '[{"id":"enterprise"}]');
  assert.equal((await getUserChatSessions(userId, "finance"))?.sessionsJson, '[{"id":"finance"}]');
});
