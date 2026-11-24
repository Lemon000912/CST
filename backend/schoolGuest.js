import { randomUUID } from "node:crypto";
import express from "express";
import { getSqliteDb, pgPool, withDatabaseTransaction } from "./db.js";
import { SCHOOL_GUEST_COOKIE, parseSchoolGuestVisitorId, resolveClientIp, schoolGuestDigest } from "./auth.js";

const COOKIE = SCHOOL_GUEST_COOKIE;
const PATH = "/api/v1";
const HOUR = 3600000;
const LEASE = 60 * 60000;

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
  return parseSchoolGuestVisitorId(req);
}

// Both adapters accept positional parameters. Convert the shared SQL for PostgreSQL.
function sql(tx, statement) {
  let n = 0;
  return tx.dialect === "postgres" ? statement.replace(/\?/g, () => "$" + ++n) : statement;
}
const guestUserId = visitor => "trial-" + visitor;
async function reconcile(tx, visitor) {
  // The shared search transaction is authoritative, including after a worker restart.
  await tx.run(sql(tx, `UPDATE school_guest_questions SET state='done',result='{}'
    WHERE visitor=? AND state='pending' AND EXISTS (SELECT 1 FROM point_operations p
      WHERE p.user_id=? AND p.operation_type='search' AND p.idempotency_key=school_guest_questions.request_id AND p.status='completed')`),
    [visitor, guestUserId(visitor)]);
  await tx.run(sql(tx, `UPDATE school_guest_questions SET state='failed'
    WHERE visitor=? AND state='pending' AND EXISTS (SELECT 1 FROM point_operations p
      WHERE p.user_id=? AND p.operation_type='search' AND p.idempotency_key=school_guest_questions.request_id AND p.updated_at>=school_guest_questions.started AND p.status='failed')`),
    [visitor, guestUserId(visitor)]);
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
    await reconcile(tx, visitor);
    const now = Date.now();
    const get = (q, args) => tx.get(sql(tx, q), args);
    const run = (q, args) => tx.run(sql(tx, q), args);
    await run("UPDATE school_guest_questions SET state='failed' WHERE visitor=? AND state='pending' AND started<=?", [visitor, now - LEASE]);
    const previous = await get("SELECT * FROM school_guest_questions WHERE visitor=? AND request_id=?", [visitor, id]);
    if (previous && previous.question !== question) throw Object.assign(new Error("请重新提交问题"), { status: 409 });
    if (previous?.state === "done") {
      if (JSON.parse(previous.result || "{}").answer) throw Object.assign(new Error("请重新提交问题"), { status: 409 });
      return null;
    }
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
    const userId = guestUserId(visitor);
    await run("INSERT INTO users (id,username,password_hash,created_at,edition) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      [userId, userId, "!", now, "school"]);
    await run("INSERT INTO point_wallets(user_id,balance_units,created_at,updated_at) VALUES (?,0,?,?) ON CONFLICT(user_id) DO NOTHING",
      [userId, now, now]);
    return now;
  });
}

export function schoolGuestRouter() {
  const router = express.Router();
  router.get("/status", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      const visitor = visitorId(req);
      const id = visitor || randomUUID();
      const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" };
      // Retain the signed ID (and used quota) from the old, narrower cookie.
      res.clearCookie(COOKIE, { ...cookieOptions, path: "/api/v1/guest" });
      res.cookie(COOKIE, id + "." + schoolGuestDigest("cookie", id), {
        ...cookieOptions, path: PATH, maxAge: 365 * 24 * HOUR,
      });
      if (visitor) await withDatabaseTransaction(tx => reconcile(tx, id));
      const rows = visitor ? await history(id) : [];
      res.json({ remaining: Math.max(0, allowance() - rows.length), scope: guestUserId(id),
        answers: rows.filter(row => typeof row.answer === "string") });
    } catch (e) { next(e); }
  });
  router.post("/ask", (_req, res) => res.status(409).json({ error: "校园版已更新，请刷新页面后重新发送。" }));
  return router;
}

export function schoolChatAccess(requireAccount, { search = false, needsAnswer = false, needsQuota = false } = {}) {
  return async (req, res, next) => {
    const visitor = visitorId(req);
    if (req.headers.authorization || !visitor) return requireAccount(req, res, next);
    try {
      const origin = req.get("Origin");
      if (origin && req.get("Sec-Fetch-Site") !== "same-origin" && new URL(origin).host !== req.get("Host")) return res.status(403).json({ error: "请求来源无效" });
      if (req.get("x-llm-chat-url") && !(req.get("x-openai-key") || req.get("x-dashscope-key") || req.get("x-deepseek-key"))) {
        return res.status(400).json({ error: "自定义模型地址需要同时填写自己的 API Key。" });
      }
      const userId = guestUserId(visitor);
      if (search) {
        const id = req.get("Idempotency-Key") || "";
        const question = String(req.body?.query ?? "").trim();
        if (!question || question.length > 12000 || !/^[\w-]{16,80}$/.test(id))
          return res.status(400).json({ error: "请输入有效问题后提交。" });
        const ip = resolveClientIp(req, "unknown");
        const network = schoolGuestDigest("network", ip);
        let started;
        try {
          started = await reserve(visitor, network, id, question, false);
        } catch (e) {
          const token = req.get("X-Guest-Challenge");
          if (e.code !== "guest-challenge" || !token || token.length > 2048) throw e;
          const validation = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST", body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
            signal: AbortSignal.timeout(7000),
          });
          if (!validation.ok || !(await validation.json()).success) throw e;
          started = await reserve(visitor, network, id, question, true);
        }
        // Before the stream opens there may be no point_operation to reconcile.
        if (started !== null) res.once("finish", () => {
          if (res.statusCode >= 400 || res.statusCode === 202) withDatabaseTransaction(tx => tx.run(sql(tx,
            "UPDATE school_guest_questions SET state='failed' WHERE visitor=? AND request_id=? AND started=? AND state='pending'"),
            [visitor, id, started])).catch(() => {});
        });
      } else if (needsAnswer || needsQuota) {
        await withDatabaseTransaction(tx => reconcile(tx, visitor));
        const used = (await history(visitor)).length;
        if (needsQuota && used >= allowance()) throw loginRequired("游客次数已用完，请注册或登录后继续。");
        if (needsAnswer && !used) return res.status(403).json({ error: "请先完成一次提问。" });
      }
      req.auth = { userId, isAdmin: false, guest: true };
      return next();
    } catch (e) {
      if (!e.status) console.error("[school guest]", e.message);
      return res.status(e.status || 503).json({ error: e.status ? e.message : "试用服务暂不可用，请稍后重试。", code: e.code, siteKey: e.siteKey });
    }
  };
}
