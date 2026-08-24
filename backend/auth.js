import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import {
  createUserRecord,
  findUserByUsernameKey,
  findUserByEmail,
  findUserByPhone,
  findUserById,
  findUserByWechatIdentity,
  bindWechatIdentityByVerifiedPhone,
  WechatIdentityLinkError,
  normalizeUsernameKey,
} from "./db.js";
import { BillingError, getPointBalance } from "./billing.js";
import {
  SmsVerificationError,
  checkRegisterVerificationCode,
  sendRegisterVerificationCode,
} from "./smsVerification.js";
import {
  WechatOAuthError,
  buildWechatAuthorizationUrl,
  clearWechatTicket,
  consumeWechatTicket,
  createWechatTicket,
  exchangeWechatCode,
  getWechatFrontendRedirect,
  getWechatTicket,
  updateWechatTicket,
} from "./wechatOAuth.js";

const JWT_ISS = "paper-query";
const WECHAT_COOKIE_PATH = "/api/v1/auth/wechat";
const WECHAT_STATE_COOKIE = "qp_wechat_oauth_state";
const WECHAT_TICKET_COOKIE = "qp_wechat_login_ticket";

export class AuthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthConfigurationError";
    this.code = "auth-configuration-error";
  }
}

function getJwtSecret() {
  const s = String(process.env.JWT_SECRET ?? "").trim();
  if (s.length >= 32) return new TextEncoder().encode(s);
  if (String(process.env.NODE_ENV ?? "").toLowerCase() === "production") {
    throw new AuthConfigurationError("JWT_SECRET must contain at least 32 characters in production");
  }
  console.warn(
    "[auth] JWT_SECRET 未设置或短于 32 字符，使用内置开发密钥；生产环境请务必在 .env 设置强随机 JWT_SECRET",
  );
  return new TextEncoder().encode("paper-query-dev-insecure-secret-min-32-chars!");
}

function parseRequestCookies(req) {
  const result = {};
  for (const part of String(req.headers?.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }
  return result;
}

function isSecureWechatCookie() {
  return String(process.env.NODE_ENV ?? "").toLowerCase() === "production"
    || /^https:\/\//i.test(String(process.env.WECHAT_OPEN_REDIRECT_URI ?? "").trim());
}

function setWechatCookie(res, name, value, maxAgeSeconds) {
  const attributes = [
    `${name}=${encodeURIComponent(String(value))}`,
    `Path=${WECHAT_COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureWechatCookie()) attributes.push("Secure");
  res.append("Set-Cookie", attributes.join("; "));
}

function clearWechatCookie(res, name) {
  setWechatCookie(res, name, "", 0);
}

function equalState(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}

function wechatTicketFromRequest(req) {
  return parseRequestCookies(req)[WECHAT_TICKET_COOKIE] ?? "";
}

async function successfulAuthPayload(user) {
  const token = await signAuthToken(user.id, user.username);
  const billing = await getPointBalance(user.id);
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      isAdmin: isConfiguredAdminUsername(user.username),
    },
    billing,
  };
}

// 邮箱验证正则
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
// 手机号验证正则（中国大陆）
const PHONE_RE = /^1[3-9]\d{9}$/;
const USERNAME_RE = /^[a-z0-9_]{2,32}$/;

function getConfiguredAdminUsernames() {
  const values = String(process.env.ADMIN_USERNAMES ?? "")
    .split(/[\s,;]+/)
    .map((value) => String(value).toLowerCase().trim())
    .filter((value) => USERNAME_RE.test(value));

  const isDevelopment = String(process.env.NODE_ENV ?? "").toLowerCase() !== "production";
  if (isDevelopment && String(process.env.SEED_DEV_ADMIN ?? "") === "1") {
    const devAdmin = String(process.env.DEV_ADMIN_USERNAME ?? "admin").toLowerCase().trim();
    if (USERNAME_RE.test(devAdmin)) values.push(devAdmin);
  }

  return new Set(values);
}

export function isConfiguredAdminUsername(raw) {
  const username = String(raw ?? "").toLowerCase().trim();
  return USERNAME_RE.test(username) && getConfiguredAdminUsernames().has(username);
}

export async function hashUserPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

export async function verifyUserPassword(plain, hash) {
  return bcrypt.compare(String(plain), String(hash ?? ""));
}

export async function signAuthToken(userId, username) {
  const secret = getJwtSecret();
  return new SignJWT({ name: String(username ?? "").slice(0, 64) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuer(JWT_ISS)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);
}

/** @returns {Promise<{ userId: string; username: string } | null>} */
export async function verifyAuthToken(token) {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(String(token ?? "").trim(), secret, { issuer: JWT_ISS });
    const sub = payload.sub;
    if (!sub) return null;
    return { userId: String(sub), username: String(payload.name ?? "") };
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw error;
    return null;
  }
}

/** @param {import("express").Request} req */
export async function resolveUserIdFromRequest(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (typeof h === "string" && /^Bearer\s+/i.test(h)) {
    const token = h.replace(/^Bearer\s+/i, "").trim();
    const v = await verifyAuthToken(token);
    if (v?.userId) return String(v.userId).slice(0, 128);
  }
  // Never trust caller-controlled identity fields. Private user data may only
  // be addressed by the subject of a server-verified bearer token.
  return "anonymous";
}

/**
 * Verify a bearer token and reload its subject from the active database.
 * Downstream handlers must use req.auth.userId rather than client fields.
 */
export async function requireAuthenticatedUser(req, res, next) {
  try {
    const header = req.headers.authorization || req.headers.Authorization;
    if (typeof header !== "string" || !/^Bearer\s+\S+/i.test(header)) {
      return res.status(401).json({ error: "未提供令牌", code: "authentication-required" });
    }
    const verified = await verifyAuthToken(header.replace(/^Bearer\s+/i, "").trim());
    if (!verified?.userId) {
      return res.status(401).json({ error: "令牌无效或已过期", code: "invalid-token" });
    }
    const currentUser = await findUserById(verified.userId);
    if (!currentUser) {
      return res.status(401).json({ error: "令牌对应的用户不存在", code: "user-not-found" });
    }
    req.auth = {
      userId: String(currentUser.id),
      username: String(currentUser.username),
      isAdmin: isConfiguredAdminUsername(currentUser.username),
    };
    return next();
  } catch (error) {
    console.error("[auth/user]", error instanceof Error ? error.message : error);
    return res.status(503).json({ error: "鉴权服务暂不可用", code: "authentication-unavailable" });
  }
}

/**
 * Protect every management endpoint with both authentication and a
 * server-side administrator allow-list. Client supplied user ids and the
 * username embedded in a token are deliberately not trusted here.
 */
export async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || req.headers.Authorization;
    if (typeof header !== "string" || !/^Bearer\s+\S+/i.test(header)) {
      return res.status(401).json({ error: "未提供管理员令牌" });
    }

    const token = header.replace(/^Bearer\s+/i, "").trim();
    const verified = await verifyAuthToken(token);
    if (!verified?.userId) {
      return res.status(401).json({ error: "令牌无效或已过期" });
    }

    const currentUser = await findUserById(verified.userId);
    if (!currentUser) {
      return res.status(401).json({ error: "令牌对应的用户不存在" });
    }
    if (!isConfiguredAdminUsername(currentUser.username)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    req.auth = {
      userId: String(currentUser.id),
      username: String(currentUser.username),
      isAdmin: true,
    };
    return next();
  } catch (error) {
    console.error("[auth/admin]", error instanceof Error ? error.message : error);
    return res.status(503).json({ error: "管理员鉴权服务未正确配置" });
  }
}

export function validateUsernameForRegister(raw) {
  const key = normalizeUsernameKey(raw);
  if (!USERNAME_RE.test(key)) {
    return {
      ok: false,
      error: "用户名须为 2～32 位小写字母、数字或下划线（将自动转为小写）",
    };
  }
  return { ok: true, username: key };
}

export function validatePasswordForRegister(raw) {
  const p = String(raw ?? "");
  if (p.length < 8 || p.length > 128) {
    return { ok: false, error: "密码长度 8～128 位" };
  }
  return { ok: true, password: p };
}

export function validateEmailForRegister(raw) {
  const e = String(raw ?? "").trim();
  if (!e) return { ok: true, email: null }; // 邮箱可选
  if (!EMAIL_RE.test(e)) {
    return { ok: false, error: "邮箱格式不正确" };
  }
  return { ok: true, email: e };
}

export function validatePhoneForRegister(raw) {
  const p = String(raw ?? "").trim();
  if (!p) return { ok: false, error: "请输入手机号" };
  if (!PHONE_RE.test(p)) {
    return { ok: false, error: "手机号格式不正确（须为11位中国大陆手机号）" };
  }
  return { ok: true, phone: p };
}

/**
 * Send a provider-managed verification code for registration.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function handleSendRegisterSmsCode(req, res) {
  try {
    const ph = validatePhoneForRegister(req.body?.phone);
    if (!ph.ok) return res.status(400).json({ error: ph.error, code: "invalid-phone" });

    const existingPhone = await findUserByPhone(ph.phone);
    if (existingPhone) {
      return res.status(409).json({ error: "手机号已被注册", code: "phone-already-registered" });
    }

    const sent = await sendRegisterVerificationCode(ph.phone);
    return res.json({ ok: true, expiresIn: sent.expiresIn });
  } catch (error) {
    if (error instanceof SmsVerificationError) {
      console.warn("[auth/sms/send]", error.code, error.providerCode || "");
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("[auth/sms/send]", error instanceof Error ? error.message : error);
    return res.status(502).json({ error: "短信服务暂时不可用", code: "sms-provider-failed" });
  }
}

function redirectWechatResult(res, params, fallbackStatus = 400) {
  try {
    return res.redirect(302, getWechatFrontendRedirect(params));
  } catch (error) {
    console.error("[auth/wechat/redirect]", error instanceof Error ? error.message : error);
    return res.status(fallbackStatus).json({
      error: "微信登录未正确配置",
      code: "wechat-not-configured",
    });
  }
}

export async function handleWechatStart(req, res) {
  try {
    const state = randomBytes(24).toString("base64url");
    setWechatCookie(res, WECHAT_STATE_COOKIE, state, 10 * 60);
    const authorizationUrl = buildWechatAuthorizationUrl(state);
    if (String(req.query?.display ?? "") === "embed") {
      res.set("Cache-Control", "no-store");
      return res.json({ authorizationUrl });
    }
    return res.redirect(302, authorizationUrl);
  } catch (error) {
    console.error("[auth/wechat/start]", error instanceof Error ? error.message : error);
    if (error instanceof WechatOAuthError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "微信登录启动失败", code: "wechat-start-failed" });
  }
}

export async function handleWechatCallback(req, res) {
  const cookies = parseRequestCookies(req);
  clearWechatCookie(res, WECHAT_STATE_COOKIE);
  const returnedState = String(req.query?.state ?? "");
  if (!equalState(cookies[WECHAT_STATE_COOKIE], returnedState)) {
    return redirectWechatResult(res, { wechat_error: "invalid_state" });
  }
  const code = String(req.query?.code ?? "").trim();
  if (!code) {
    return redirectWechatResult(res, { wechat_error: "cancelled" });
  }

  try {
    const identity = await exchangeWechatCode(code);
    const linkedUser = await findUserByWechatIdentity(identity);
    const ticket = createWechatTicket(
      linkedUser
        ? { kind: "login", userId: linkedUser.id }
        : { kind: "bind", identity },
    );
    setWechatCookie(res, WECHAT_TICKET_COOKIE, ticket.token, ticket.expiresIn);
    return redirectWechatResult(res, { wechat: "complete" });
  } catch (error) {
    console.warn(
      "[auth/wechat/callback]",
      error?.code || error?.name || "unknown",
      error?.providerCode || "",
    );
    const codeValue = error instanceof WechatOAuthError ? error.code : "wechat-callback-failed";
    return redirectWechatResult(res, { wechat_error: codeValue }, error?.status ?? 502);
  }
}

export async function handleWechatSession(req, res) {
  try {
    const ticketToken = wechatTicketFromRequest(req);
    const ticket = getWechatTicket(ticketToken);
    if (!ticket) {
      clearWechatCookie(res, WECHAT_TICKET_COOKIE);
      return res.status(401).json({ error: "微信登录已过期，请重新扫码", code: "wechat-ticket-expired" });
    }
    if (ticket.kind === "bind") {
      return res.json({
        requiresPhone: true,
        wechat: {
          nickname: ticket.identity.nickname,
          avatarUrl: ticket.identity.avatarUrl,
        },
      });
    }
    if (ticket.kind !== "login") {
      clearWechatTicket(ticketToken);
      clearWechatCookie(res, WECHAT_TICKET_COOKIE);
      return res.status(400).json({ error: "微信登录状态无效", code: "wechat-ticket-invalid" });
    }
    const consumed = consumeWechatTicket(ticketToken);
    clearWechatCookie(res, WECHAT_TICKET_COOKIE);
    const user = consumed ? await findUserById(consumed.userId) : null;
    if (!user) {
      return res.status(401).json({ error: "微信绑定账号不存在", code: "wechat-user-not-found" });
    }
    return res.json(await successfulAuthPayload(user));
  } catch (error) {
    console.error("[auth/wechat/session]", error instanceof Error ? error.message : error);
    return res.status(500).json({ error: "微信登录失败", code: "wechat-session-failed" });
  }
}

export async function handleSendWechatBindSmsCode(req, res) {
  try {
    const ticket = getWechatTicket(wechatTicketFromRequest(req));
    if (!ticket || ticket.kind !== "bind") {
      return res.status(401).json({ error: "微信登录已过期，请重新扫码", code: "wechat-ticket-expired" });
    }
    const phoneResult = validatePhoneForRegister(req.body?.phone);
    if (!phoneResult.ok) {
      return res.status(400).json({ error: phoneResult.error, code: "invalid-phone" });
    }
    const sent = await sendRegisterVerificationCode(phoneResult.phone);
    return res.json({ ok: true, expiresIn: sent.expiresIn });
  } catch (error) {
    if (error instanceof SmsVerificationError) {
      console.warn("[auth/wechat/sms]", error.code, error.providerCode || "");
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("[auth/wechat/sms]", error instanceof Error ? error.message : error);
    return res.status(502).json({ error: "短信服务暂时不可用", code: "sms-provider-failed" });
  }
}

export async function handleWechatBindPhone(req, res) {
  const ticketToken = wechatTicketFromRequest(req);
  try {
    const ticket = getWechatTicket(ticketToken);
    if (!ticket || ticket.kind !== "bind") {
      clearWechatCookie(res, WECHAT_TICKET_COOKIE);
      return res.status(401).json({ error: "微信登录已过期，请重新扫码", code: "wechat-ticket-expired" });
    }
    const phoneResult = validatePhoneForRegister(req.body?.phone);
    if (!phoneResult.ok) return res.status(400).json({ error: phoneResult.error, code: "invalid-phone" });
    if (ticket.verifiedPhone) {
      if (ticket.verifiedPhone !== phoneResult.phone) {
        return res.status(400).json({
          error: "手机号与已验证号码不一致，请重新扫码",
          code: "wechat-verified-phone-mismatch",
        });
      }
    } else {
      await checkRegisterVerificationCode(phoneResult.phone, req.body?.smsCode);
      updateWechatTicket(ticketToken, { verifiedPhone: phoneResult.phone });
    }

    const existingUser = await findUserByPhone(phoneResult.phone);
    let newUser = null;
    if (!existingUser) {
      if (!String(req.body?.username ?? "").trim() || !String(req.body?.password ?? "")) {
        return res.status(428).json({
          error: "该手机号尚未注册，请设置用户名和密码完成新账号创建",
          code: "wechat-new-account-details-required",
          requiresAccountDetails: true,
        });
      }
      const usernameResult = validateUsernameForRegister(req.body?.username);
      if (!usernameResult.ok) return res.status(400).json({ error: usernameResult.error, code: "invalid-username" });
      if (isConfiguredAdminUsername(usernameResult.username)) {
        return res.status(409).json({ error: "用户名已被占用", code: "username-unavailable" });
      }
      const passwordResult = validatePasswordForRegister(req.body?.password);
      if (!passwordResult.ok) return res.status(400).json({ error: passwordResult.error, code: "invalid-password" });
      const emailResult = validateEmailForRegister(req.body?.email);
      if (!emailResult.ok) return res.status(400).json({ error: emailResult.error, code: "invalid-email" });
      newUser = {
        id: randomUUID(),
        username: usernameResult.username,
        passwordHash: await hashUserPassword(passwordResult.password),
        email: emailResult.email,
      };
    }

    const result = await bindWechatIdentityByVerifiedPhone({
      identity: ticket.identity,
      phone: phoneResult.phone,
      newUser,
    });
    consumeWechatTicket(ticketToken);
    clearWechatCookie(res, WECHAT_TICKET_COOKIE);
    return res.status(result.created ? 201 : 200).json({
      ...(await successfulAuthPayload(result.user)),
      accountCreated: result.created,
    });
  } catch (error) {
    if (error instanceof SmsVerificationError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error instanceof WechatIdentityLinkError) {
      const status = ["wechat-account-already-bound", "wechat-identity-already-bound"].includes(error.code) ? 409 : 400;
      return res.status(status).json({ error: error.message, code: error.code });
    }
    if (error instanceof BillingError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("[auth/wechat/bind]", error);
    return res.status(500).json({ error: "微信绑定失败", code: "wechat-bind-failed" });
  }
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function handleRegister(req, res) {
  try {
    const u = validateUsernameForRegister(req.body?.username);
    if (!u.ok) return res.status(400).json({ error: u.error });
    if (isConfiguredAdminUsername(u.username)) {
      return res.status(409).json({ error: "用户名已被占用" });
    }
    const p = validatePasswordForRegister(req.body?.password);
    if (!p.ok) return res.status(400).json({ error: p.error });

    // 验证邮箱
    const e = validateEmailForRegister(req.body?.email);
    if (!e.ok) return res.status(400).json({ error: e.error });

    // 验证手机号
    const ph = validatePhoneForRegister(req.body?.phone);
    if (!ph.ok) return res.status(400).json({ error: ph.error });

    // 检查用户名是否已存在
    const existing = await findUserByUsernameKey(u.username);
    if (existing) return res.status(409).json({ error: "用户名已被注册" });

    // 检查邮箱是否已存在
    if (e.email) {
      const existingEmail = await findUserByEmail(e.email);
      if (existingEmail) return res.status(409).json({ error: "邮箱已被注册" });
    }

    // 检查手机号是否已存在
    if (ph.phone) {
      const existingPhone = await findUserByPhone(ph.phone);
      if (existingPhone) return res.status(409).json({ error: "手机号已被注册" });
    }

    // The code is bound by the provider to this phone number and scene.
    await checkRegisterVerificationCode(ph.phone, req.body?.smsCode);

    const id = randomUUID();
    const hash = await hashUserPassword(p.password);
    const created = await createUserRecord(id, u.username, hash, e.email, ph.phone);
    const token = await signAuthToken(id, u.username);
    return res.status(201).json({
      token,
      user: { id, username: u.username, email: e.email, phone: ph.phone },
      billing: {
        userId: id,
        balanceUnits: created.balanceUnits,
        availableUnits: created.balanceUnits,
        balance: "1000.00",
      },
    });
  } catch (err) {
    console.error("[auth/register]", err);
    if (err instanceof SmsVerificationError) {
      console.warn("[auth/register/sms]", err.code, err.providerCode || "");
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof AuthConfigurationError) {
      return res.status(503).json({ error: "鉴权服务未正确配置", code: err.code });
    }
    return res.status(500).json({ error: "注册失败" });
  }
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function handleLogin(req, res) {
  try {
    const u = validateUsernameForRegister(req.body?.username);
    if (!u.ok) return res.status(400).json({ error: u.error });
    const password = String(req.body?.password ?? "");
    if (!password) return res.status(400).json({ error: "请输入密码" });

    const row = await findUserByUsernameKey(u.username);
    if (!row || !(await verifyUserPassword(password, row.password_hash))) {
      return res.status(401).json({ error: "用户名或密码错误" });
    }
    const token = await signAuthToken(row.id, row.username);
    const billing = await getPointBalance(row.id);
    return res.json({
      token,
      user: {
        id: row.id,
        username: row.username,
        isAdmin: isConfiguredAdminUsername(row.username),
      },
      billing,
    });
  } catch (e) {
    console.error("[auth/login]", e);
    if (e instanceof BillingError) {
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    if (e instanceof AuthConfigurationError) {
      return res.status(503).json({ error: "鉴权服务未正确配置", code: e.code });
    }
    return res.status(500).json({ error: "登录失败" });
  }
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function handleMe(req, res) {
  try {
    const h = req.headers.authorization || req.headers.Authorization;
    if (!h || typeof h !== "string" || !/^Bearer\s+/i.test(h)) {
      return res.status(401).json({ error: "未提供令牌" });
    }
    const token = h.replace(/^Bearer\s+/i, "").trim();
    const v = await verifyAuthToken(token);
    if (!v) return res.status(401).json({ error: "令牌无效或已过期" });
    const currentUser = await findUserById(v.userId);
    if (!currentUser) return res.status(401).json({ error: "令牌对应的用户不存在" });
    const billing = await getPointBalance(currentUser.id);
    return res.json({
      user: {
        id: currentUser.id,
        username: currentUser.username,
        isAdmin: isConfiguredAdminUsername(currentUser.username),
      },
      billing,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("[auth/me]", error);
    return res.status(503).json({ error: "鉴权服务暂不可用" });
  }
}
