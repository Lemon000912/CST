import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { getSqliteDb, pgPool, withDatabaseTransaction } from "./db.js";
import { schoolGuestDigest } from "./auth.js";

const COOKIE = "cst_school_trial";
const PATH = "/api/v1/guest";
const HOUR = 3600000;
const LEASE = 5 * 60000;

function limit(name, fallback) {
  const value = process.env[name]?.trim();
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
}
const allowance = () => limit("SCHOOL_GUEST_LIMIT", 2);
const loginRequired = message => Object.assign(new Error(message), { status: 401, code: "guest-login-required" });

export async function initSchoolGuest() {
  await withDatabaseTransaction(async tx => {
    await tx.run("CREATE TABLE IF NOT EXISTS school_guest_budget(day INTEGER PRIMARY KEY, attempts INTEGER NOT NULL)");
    await tx.run(`CREATE TABLE IF NOT EXISTS school_guest_questions (
      visitor TEXT NOT NULL, request_id TEXT NOT NULL, question TEXT NOT NULL,
      started BIGINT NOT NULL, network TEXT NOT NULL, first_use INTEGER NOT NULL,
      state TEXT NOT NULL, result TEXT, PRIMARY KEY(visitor, request_id))`);
    await tx.run("CREATE INDEX IF NOT EXISTS school_guest_started ON school_guest_questions(started)");
    await tx.run("CREATE INDEX IF NOT EXISTS school_guest_network ON school_guest_questions(network,started)");
  });
}

function visitorId(req) {
  const token = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="));
  const match = token?.slice(COOKIE.length + 1).match(/^([\da-f-]{36})\.([\da-f]{64})$/);
  if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(schoolGuestDigest("cookie", match[1])))) return null;
  return match[1];
}

// Both adapters accept positional parameters. Convert the shared SQL for PostgreSQL.
function sql(tx, statement) {
  let n = 0;
  return tx.dialect === "postgres" ? statement.replace(/\?/g, () => "$" + ++n) : statement;
}
async function history(visitor) {
  const query = "SELECT request_id,started,question,result FROM school_guest_questions WHERE visitor=? AND state='done' ORDER BY started";
  const rows = pgPool ? (await pgPool.query(sql({ dialect: "postgres" }, query), [visitor])).rows
    : await (await getSqliteDb()).all(query, [visitor]);
  return rows.map(row => ({ requestId: row.request_id, started: Number(row.started), question: row.question, ...JSON.parse(row.result) }));
}

async function reserve(visitor, network, id, question, verified) {
  return withDatabaseTransaction(async tx => {
    // Serialize the short admission decision across workers, including the global daily cap.
    if (tx.dialect === "postgres") await tx.get("SELECT pg_advisory_xact_lock(172903441)");
    const now = Date.now();
    const get = (q, args) => tx.get(sql(tx, q), args);
    const run = (q, args) => tx.run(sql(tx, q), args);
    await run("UPDATE school_guest_questions SET state='failed' WHERE visitor=? AND state='pending' AND started<=?", [visitor, now - LEASE]);
    const previous = await get("SELECT * FROM school_guest_questions WHERE visitor=? AND request_id=?", [visitor, id]);
    if (previous && previous.question !== question) throw Object.assign(new Error("请重新提交问题"), { status: 409 });
    if (previous?.state === "done") return null;
    const stats = await get(`SELECT COUNT(*) AS attempts, MAX(started) AS last,
      COUNT(CASE WHEN state='done' THEN 1 END) AS used,
      COUNT(CASE WHEN state='pending' AND started>? THEN 1 END) AS busy
      FROM school_guest_questions WHERE visitor=?`, [now - LEASE, visitor]);
    if (Number(stats.used) >= allowance()) throw loginRequired("游客次数已用完，请注册或登录后继续提问。");
    if (Number(stats.busy) || now - Number(stats.last) < 10000)
      throw Object.assign(new Error("请等待当前提问完成，两次提问至少间隔 10 秒。"), { status: 429 });
    if (!Number(stats.attempts)) {
      const row = await get("SELECT COUNT(*) AS n FROM school_guest_questions WHERE network=? AND first_use=1 AND started>?", [network, now - HOUR]);
      const threshold = limit("SCHOOL_GUEST_NEW_PER_IP_HOUR", 12);
      if (Number(row.n) >= threshold * 2) throw loginRequired("当前网络试用人数较多，请登录后继续。");
      if (Number(row.n) >= threshold && !verified) {
        if (process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY)
          throw Object.assign(new Error("请先完成人机验证"), { status: 403, code: "guest-challenge", siteKey: process.env.TURNSTILE_SITE_KEY });
        throw loginRequired("当前网络试用人数较多，请登录后继续。");
      }
    }
    // Count every admitted invocation, including failed retries, in the site budget.
    const day = Math.floor((now + 8 * HOUR) / (24 * HOUR));
    await run("INSERT INTO school_guest_budget(day, attempts) VALUES(?,0) ON CONFLICT(day) DO NOTHING", [day]);
    const budget = await get("SELECT attempts FROM school_guest_budget WHERE day=?", [day]);
    if (Number(budget.attempts) >= limit("SCHOOL_GUEST_DAILY_REQUESTS", 200))
      throw loginRequired("今日游客试用名额已用完，请注册或登录后继续。");
    await run("UPDATE school_guest_budget SET attempts=attempts+1 WHERE day=?", [day]);
    await run(`INSERT INTO school_guest_questions(visitor,request_id,question,started,network,first_use,state)
      VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(visitor,request_id) DO UPDATE SET started=excluded.started,state='pending'`,
      [visitor, id, question, now, network, Number(stats.attempts) ? 0 : 1]);
    return now;
  });
}

export function schoolGuestRouter({ answer, clientIp }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const status = async visitor => {
    const answers = await history(visitor);
    return { remaining: Math.max(0, allowance() - answers.length), answers };
  };
  router.get("/status", async (req, res, next) => {
    try {
      const visitor = visitorId(req);
      if (visitor) return res.json(await status(visitor));
      const id = randomUUID();
      res.cookie(COOKIE, id + "." + schoolGuestDigest("cookie", id), {
        httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: PATH, maxAge: 365 * 24 * HOUR,
      });
      res.json({ remaining: allowance(), answers: [] });
    } catch (e) { next(e); }
  });
  router.post("/ask", async (req, res) => {
    try {
      const visitor = visitorId(req);
      if (!visitor) throw loginRequired("请启用 Cookie 后刷新页面，或登录继续。");
      const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
      const id = req.get("Idempotency-Key") || "";
      if (!question || question.length > 800 || !/^[\w-]{16,80}$/.test(id))
        return res.status(400).json({ error: "请输入 1 至 800 字的问题后提交。" });
      const ip = clientIp(req);
      try {
        await admit(false);
      } catch (e) {
        const token = req.body?.challenge;
        if (e.code !== "guest-challenge" || typeof token !== "string" || !token || token.length > 2048) throw e;
        const validation = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST", body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
          signal: AbortSignal.timeout(7000),
        });
        if (!validation.ok || (await validation.json()).success !== true) throw e;
        await admit(true);
      }
      async function admit(challengePassed) {
        const started = await reserve(visitor, schoolGuestDigest("network", ip), id, question, challengePassed);
        if (started === null) return;
        const settle = (state, result) => withDatabaseTransaction(tx => tx.run(sql(tx,
          "UPDATE school_guest_questions SET state=?,result=? WHERE visitor=? AND request_id=? AND started=? AND state='pending'"),
          [state, result, visitor, id, started]));
        try {
          const result = await answer(question, AbortSignal.timeout(120000), req.body?.options ?? {});
          const sessionId = typeof req.body?.sessionId === "string" && /^[\w-]{1,80}$/.test(req.body.sessionId)
            ? req.body.sessionId : id;
          await settle("done", JSON.stringify({ ...result, sessionId }));
        } catch (e) {
          await settle("failed", null);
          throw e;
        }
      }
      res.json(await status(visitor));
    } catch (e) {
      if (!e.status) console.error("[school guest]", e.message);
      res.status(e.status || 503).json({ error: e.status ? e.message : "试用服务暂不可用，请稍后重试。", code: e.code, siteKey: e.siteKey });
    }
  });
  return router;
}
