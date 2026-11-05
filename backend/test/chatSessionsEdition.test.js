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

test("终稿随结算事务落库且重放不重复；旧草稿不能覆盖终稿", async () => {
  const { completeImmediateBillableOperation }=await import('../billing.js');
  const userId='atomic-final-user';await createUserRecord(userId,'atomic_final_user','unused');
  const args={userId,operationType:'search',idempotencyKey:'finished',request:{q:'test'},costUnits:0,billingDetails:{edition:'school'},result:{adminQa:{question:'问题'},chatSession:{sessionId:'chat-a',userMessageId:'u-a',assistantMessageId:'a-a'},papers:[],synthesis:'完整仲裁终稿',synthesisNote:'synth:completed'}};
  const done=await completeImmediateBillableOperation(args);
  let snapshot=await getUserChatSessions(userId,'school');let session=JSON.parse(snapshot.sessionsJson)[0];
  assert.equal(session.messages[1].meta.synthesis,'完整仲裁终稿');assert.equal(session.messages[1].meta.billing.operationId,done.operation.id);assert.ok(session.messages[1].meta.finalizedAt);
  const replay=await completeImmediateBillableOperation(args);assert.equal(replay.replayed,true);assert.equal((await getUserChatSessions(userId,'school')).revision,snapshot.revision);
  const stale={...session,updatedAt:Date.now()+1000,messages:[session.messages[0],{id:'a-a',role:'assistant',content:'',meta:{synthesis:'草稿',synthesisNote:'synth:streaming'}}]};
  await saveUserChatSessions(userId,JSON.stringify([stale]),Date.now(),null,'school');
  snapshot=await getUserChatSessions(userId,'school');session=JSON.parse(snapshot.sessionsJson)[0];assert.equal(session.messages[1].meta.synthesis,'完整仲裁终稿');
  const clean=await saveUserChatSessions(userId,snapshot.sessionsJson,Date.now(),snapshot.revision,'school');assert.equal(clean.revision,snapshot.revision,'无变化时不能递增版本');
});

test("生成期间删除会话，结算和旧页面同步都不能复活它", async () => {
  const {completeImmediateBillableOperation}=await import('../billing.js');
  const userId='deleted-chat-user';await createUserRecord(userId,'deleted_chat_user','unused');
  const a=await saveUserChatSessions(userId,'[{"id":"deleted","updatedAt":1,"messages":[]}]',1,null,'school');
  await saveUserChatSessions(userId,'[]',2,a.revision,'school',['deleted']);
  await completeImmediateBillableOperation({userId,operationType:'search',idempotencyKey:'deleted-result',request:{q:'deleted'},costUnits:0,billingDetails:{edition:'school'},result:{adminQa:{question:'已删除的问题'},chatSession:{sessionId:'deleted',userMessageId:'u',assistantMessageId:'a'},synthesis:'终稿'}});
  await saveUserChatSessions(userId,'[{"id":"deleted","updatedAt":9999999999999,"messages":[]}]',Date.now(),null,'school');
  const result=await getUserChatSessions(userId,'school');assert.deepEqual(JSON.parse(result.sessionsJson),[]);assert.deepEqual(result.deletedSessionIds,['deleted']);
});

test("历史落库失败会使结算一起回滚",async()=>{
  const {completeImmediateBillableOperation,getPointBalance}=await import('../billing.js');const userId='atomic-fail-user';await createUserRecord(userId,'atomic_fail_user','unused');const db=await getSqliteDb();const before=await getPointBalance(userId);
  await db.exec("CREATE TRIGGER reject_test_chat BEFORE INSERT ON user_chat_session_items WHEN NEW.user_id='atomic-fail-user' BEGIN SELECT RAISE(ABORT,'test chat failure'); END;");
  try{await assert.rejects(completeImmediateBillableOperation({userId,operationType:'search',idempotencyKey:'fail',request:{q:'fail'},costUnits:1,billingDetails:{edition:'school'},result:{adminQa:{question:'失败测试'},chatSession:{sessionId:'f',userMessageId:'fu',assistantMessageId:'fa'},synthesis:'终稿'}}));assert.equal((await getPointBalance(userId)).balanceUnits,before.balanceUnits);assert.equal((await db.get('SELECT COUNT(*) AS count FROM point_operations WHERE user_id=?',[userId])).count,0);}finally{await db.exec('DROP TRIGGER reject_test_chat');}
});
