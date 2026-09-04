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

  await saveUserChatSessions(userId, '[{"id":"school"}]', Date.now(), null, "school");
  await saveUserChatSessions(userId, '[{"id":"enterprise"}]', Date.now(), null, "enterprise");

  assert.equal((await getUserChatSessions(userId, "school"))?.sessionsJson, '[{"id":"school"}]');
  assert.equal((await getUserChatSessions(userId, "enterprise"))?.sessionsJson, '[{"id":"enterprise"}]');
});
