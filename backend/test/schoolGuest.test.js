import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const file = path.join(os.tmpdir(), "guest-" + randomUUID() + ".sqlite");
Object.assign(process.env, { SQLITE_FILE: file, APP_EDITION: "school", DATABASE_URL: "", POSTGRES_URL: "",
  USE_POSTGRES: "false", JWT_SECRET: "unit-test-secret-01234567890123456789", SCHOOL_GUEST_LIMIT: "2",
  SCHOOL_GUEST_NEW_PER_IP_HOUR: "1", SCHOOL_GUEST_DAILY_REQUESTS: "3", TURNSTILE_SECRET_KEY: "" });
const { initSchoolGuest, schoolGuestRouter, schoolChatAccess } = await import("../schoolGuest.js");
const { resolveClientIp } = await import("../auth.js");
const { beginBillableOperation, completeBillableOperation, failBillableOperation } = await import("../billing.js");
const {
  createUserRecord,
  getSqliteDb,
  getUserChatSessions,
  initDatabase,
  migrateUserChatSessions,
  saveUserChatSessions,
} = await import("../db.js");

test("school guest HTTP admission, retry, concurrency, refund and persisted exhaustion", async t => {
  await initDatabase();
  await initSchoolGuest();
  const db = await getSqliteDb();
  let calls = 0;
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const rejectAccount = (_req, res) => res.sendStatus(401);
  const app = express().use(express.json()).use("/guest", schoolGuestRouter());
  app.post("/search", schoolChatAccess(rejectAccount, { search: true }), async (req, res) => {
    const userId = req.auth.userId;
    const idempotencyKey = req.get("Idempotency-Key");
    const { operation, replayed } = await beginBillableOperation({ userId, operationType: "search",
      idempotencyKey, request: req.body, allowZeroBalance: true });
    if (!replayed) {
      calls++;
      const key = { operationId: operation.id, leaseToken: operation.leaseToken, userId };
      if (calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
      if (calls === 2) {
        await failBillableOperation({ ...key, errorCode: "unavailable" });
        return res.sendStatus(503);
      }
      await completeBillableOperation({ ...key, costUnits: 0, result: { synthesis: req.body.query } });
    }
    res.json({ ok: true });
  });
  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(file, { force: true });
  });
  const url = "http://127.0.0.1:" + server.address().port + "/guest";
  const cookie = async () => (await fetch(url + "/status")).headers.getSetCookie().at(-1).split(";")[0];
  const visitor = await cookie();
  const status = async () => (await fetch(url + "/status", { headers: { Cookie: visitor } })).json();
  const ask = (id, q, identity = visitor, network = "campus") => fetch(url.replace("/guest", "/search"), { method: "POST",
    headers: { Cookie: identity, "Content-Type": "application/json", "Idempotency-Key": id, "X-Forwarded-For": network },
    body: JSON.stringify({ query: q }) });
  const first = randomUUID();
  const next = randomUUID();
  const pending = ask(first, "one");
  await started;
  assert.equal((await ask(next, "two")).status, 429);
  release();
  assert.equal((await pending).status, 200);
  assert.equal((await status()).remaining, 1);
  assert.equal((await ask(first, "one")).status, 200);
  assert.equal((await status()).remaining, 1);
  assert.equal((await ask(next, "two")).status, 429);
  assert.equal((await ask(next, "two", await cookie())).status, 401);
  await db.run("UPDATE school_guest_questions SET started=started-11000");
  assert.equal((await ask(next, "two")).status, 503);
  await db.run("UPDATE school_guest_questions SET started=started-11000");
  assert.equal((await status()).remaining, 1);
  assert.equal((await ask(next, "two")).status, 200);
  const state = await (await fetch(url + "/status", { headers: { Cookie: visitor } })).json();
  assert.equal(state.remaining, 0);
  assert.equal((await ask(randomUUID(), "three")).status, 401);
  assert.equal((await (await ask(randomUUID(), "other", await cookie(), "other")).json()).error, "今日游客试用名额已用完，请注册或登录后继续。");
  assert.equal(calls, 3);
});

test("resolveClientIp supports single-hop default and multi-hop TRUSTED_PROXY_HOPS consistently", () => {
  const prev = process.env.TRUSTED_PROXY_HOPS;
  try {
    delete process.env.TRUSTED_PROXY_HOPS;
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.10, 10.0.0.2" },
    };
    assert.equal(resolveClientIp(req), "10.0.0.2");
    process.env.TRUSTED_PROXY_HOPS = "2";
    assert.equal(resolveClientIp(req), "203.0.113.10");
    assert.equal(
      resolveClientIp({ socket: { remoteAddress: "198.51.100.7" }, headers: { "x-forwarded-for": "1.2.3.4" } }),
      "198.51.100.7",
    );
  } finally {
    if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = prev;
  }
});

test("migrateUserChatSessions merges school guest history into account and clears guest source", async () => {
  await initDatabase();
  const guestId = "trial-" + randomUUID();
  const targetId = "user-" + randomUUID();
  await createUserRecord(targetId, "migrated_student", "unused-hash");
  await saveUserChatSessions(
    guestId,
    JSON.stringify([{ id: "guest-sess-1", title: "游客试用提问", messages: [{ id: "m1", role: "user", content: "测试问题" }], updatedAt: 1000 }]),
    1000,
    null,
    "school",
  );
  await saveUserChatSessions(
    targetId,
    JSON.stringify([{ id: "acct-sess-1", title: "原有会话", messages: [{ id: "m0", role: "user", content: "老问题" }], updatedAt: 900 }]),
    900,
    null,
    "school",
  );

  const migrated = await migrateUserChatSessions(guestId, targetId, "school");
  assert.equal(migrated.ok, true);
  assert.equal(migrated.migratedCount, 1);

  const targetRow = await getUserChatSessions(targetId, "school");
  const targetSessions = JSON.parse(targetRow.sessionsJson);
  assert.deepEqual(new Set(targetSessions.map((s) => s.id)), new Set(["guest-sess-1", "acct-sess-1"]));

  const guestAfter = await getUserChatSessions(guestId, "school");
  assert.equal(guestAfter, null);
});
