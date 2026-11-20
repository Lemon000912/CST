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
const { initSchoolGuest, schoolGuestRouter } = await import("../schoolGuest.js");
const { getSqliteDb } = await import("../db.js");

test("school guest HTTP admission, retry, concurrency, refund and persisted exhaustion", async t => {
  await initSchoolGuest();
  const db = await getSqliteDb();
  let calls = 0;
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const app = express().use(express.json()).use("/guest", schoolGuestRouter({
    clientIp: req => req.get("Test-Network") || "campus",
    answer: async question => {
      calls++;
      if (calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
      if (calls === 2) throw Error("simulated failure");
      return { answer: question, sources: [] };
    },
  }));
  const server = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(file, { force: true });
  });
  const url = "http://127.0.0.1:" + server.address().port + "/guest";
  const cookie = async () => (await fetch(url + "/status")).headers.get("set-cookie").split(";")[0];
  const visitor = await cookie();
  const ask = (id, q, identity = visitor, network = "campus") => fetch(url + "/ask", { method: "POST",
    headers: { Cookie: identity, "Content-Type": "application/json", "Idempotency-Key": id, "Test-Network": network },
    body: JSON.stringify({ question: q }) });
  const first = randomUUID();
  const next = randomUUID();
  const pending = ask(first, "one");
  await started;
  assert.equal((await ask(next, "two")).status, 429);
  release();
  assert.equal((await (await pending).json()).remaining, 1);
  assert.equal((await (await ask(first, "one")).json()).remaining, 1);
  assert.equal((await ask(next, "two")).status, 429);
  assert.equal((await ask(next, "two", await cookie())).status, 401);
  await db.run("UPDATE school_guest_questions SET started=started-11000");
  assert.equal((await ask(next, "two")).status, 503);
  await db.run("UPDATE school_guest_questions SET started=started-11000");
  assert.equal((await (await ask(next, "two")).json()).remaining, 0);
  const state = await (await fetch(url + "/status", { headers: { Cookie: visitor } })).json();
  assert.equal(state.answers.length, 2);
  assert.equal((await ask(randomUUID(), "three")).status, 401);
  assert.equal((await (await ask(randomUUID(), "other", await cookie(), "other")).json()).error, "今日游客试用名额已用完，请注册或登录后继续。");
  assert.equal(calls, 3);
});
