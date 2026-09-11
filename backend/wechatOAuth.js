import { randomBytes } from "node:crypto";
import { getConfiguredAppEdition } from "./appEdition.js";

const AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect";
const API_ORIGIN = "https://api.weixin.qq.com";
const TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_TICKETS = 5_000;

export class WechatOAuthError extends Error {
  constructor(message, { code = "wechat-oauth-error", status = 502, providerCode = "" } = {}) {
    super(message);
    this.name = "WechatOAuthError";
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
  }
}

function env(name) {
  return String(process.env[name] ?? "").trim();
}

function editionEnv(name) {
  const editionPrefix = getConfiguredAppEdition().toUpperCase();
  return env(`${editionPrefix}_${name}`) || env(name);
}

function normalizedHttpUrl(value, field) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw new WechatOAuthError(`${field} 不是有效的 HTTP(S) 地址`, {
      code: "wechat-not-configured",
      status: 503,
    });
  }
}

function hostMatchesCookieDomain(hostname, cookieDomain) {
  return hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`);
}

export function getWechatOAuthConfig() {
  const callbackUrl = editionEnv("WECHAT_OPEN_REDIRECT_URI");
  let frontendUrl = editionEnv("WECHAT_OPEN_FRONTEND_URL");
  if (!frontendUrl && callbackUrl) {
    try {
      frontendUrl = `${new URL(callbackUrl).origin}/`;
    } catch {
      // Configuration validation reports the malformed callback later.
    }
  }
  return {
    appId: editionEnv("WECHAT_OPEN_APP_ID"),
    appSecret: editionEnv("WECHAT_OPEN_APP_SECRET"),
    callbackUrl,
    frontendUrl,
    authorizeUrl: editionEnv("WECHAT_OPEN_AUTHORIZE_URL") || AUTHORIZE_URL,
    apiOrigin: (editionEnv("WECHAT_OPEN_API_ORIGIN") || API_ORIGIN).replace(/\/+$/, ""),
  };
}

export function isWechatOAuthConfigured() {
  const config = getWechatOAuthConfig();
  return Boolean(config.appId && config.appSecret && config.callbackUrl && config.frontendUrl);
}

function requireWechatOAuthConfig() {
  const config = getWechatOAuthConfig();
  const missing = [];
  if (!config.appId) missing.push("WECHAT_OPEN_APP_ID");
  if (!config.appSecret) missing.push("WECHAT_OPEN_APP_SECRET");
  if (!config.callbackUrl) missing.push("WECHAT_OPEN_REDIRECT_URI");
  if (!config.frontendUrl) missing.push("WECHAT_OPEN_FRONTEND_URL");
  if (missing.length) {
    throw new WechatOAuthError(`微信登录未配置：${missing.join(", ")}`, {
      code: "wechat-not-configured",
      status: 503,
    });
  }
  config.callbackUrl = normalizedHttpUrl(config.callbackUrl, "WECHAT_OPEN_REDIRECT_URI");
  config.frontendUrl = normalizedHttpUrl(config.frontendUrl, "WECHAT_OPEN_FRONTEND_URL");
  config.authorizeUrl = normalizedHttpUrl(config.authorizeUrl, "WECHAT_OPEN_AUTHORIZE_URL");
  config.apiOrigin = normalizedHttpUrl(config.apiOrigin, "WECHAT_OPEN_API_ORIGIN").replace(/\/+$/, "");
  if (String(process.env.NODE_ENV ?? "").toLowerCase() === "production") {
    if (!config.callbackUrl.startsWith("https://") || !config.frontendUrl.startsWith("https://")) {
      throw new WechatOAuthError("生产环境微信登录回调和前端地址必须使用 HTTPS", {
        code: "wechat-not-configured",
        status: 503,
      });
    }
  }
  return config;
}

export function createWechatOAuthState(edition = getConfiguredAppEdition()) {
  const normalizedEdition = String(edition ?? "").trim().toLowerCase();
  if (normalizedEdition !== "school" && normalizedEdition !== "enterprise") {
    throw new WechatOAuthError("微信登录版本无效", {
      code: "wechat-not-configured",
      status: 503,
    });
  }
  return `${normalizedEdition}.${randomBytes(24).toString("base64url")}`;
}

export function getWechatOAuthStateEdition(state) {
  const match = /^(school|enterprise)\.([A-Za-z0-9_-]{32})$/.exec(String(state ?? ""));
  return match?.[1] ?? null;
}

export function getWechatOAuthStateCookieDomain() {
  const config = requireWechatOAuthConfig();
  const callbackHost = new URL(config.callbackUrl).hostname.toLowerCase();
  const frontendHost = new URL(config.frontendUrl).hostname.toLowerCase();
  if (callbackHost === frontendHost) return "";

  const cookieDomain = editionEnv("WECHAT_OPEN_COOKIE_DOMAIN")
    .replace(/^\.+/, "")
    .toLowerCase();
  if (!cookieDomain
    || !hostMatchesCookieDomain(callbackHost, cookieDomain)
    || !hostMatchesCookieDomain(frontendHost, cookieDomain)) {
    throw new WechatOAuthError("跨域微信登录需要正确配置 WECHAT_OPEN_COOKIE_DOMAIN", {
      code: "wechat-not-configured",
      status: 503,
    });
  }
  return cookieDomain;
}

export function buildWechatEnterpriseCallbackRelayUrl(params = {}) {
  const configuredUrl = env("WECHAT_OPEN_ENTERPRISE_CALLBACK_URI");
  if (!configuredUrl) {
    throw new WechatOAuthError("微信登录未配置：WECHAT_OPEN_ENTERPRISE_CALLBACK_URI", {
      code: "wechat-not-configured",
      status: 503,
    });
  }
  const url = new URL(normalizedHttpUrl(configuredUrl, "WECHAT_OPEN_ENTERPRISE_CALLBACK_URI"));
  if (String(process.env.NODE_ENV ?? "").toLowerCase() === "production" && url.protocol !== "https:") {
    throw new WechatOAuthError("生产环境企业版微信回调中继必须使用 HTTPS", {
      code: "wechat-not-configured",
      status: 503,
    });
  }
  url.search = "";
  url.hash = "";
  for (const key of ["code", "state"]) {
    const value = String(params?.[key] ?? "").trim();
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function buildWechatAuthorizationUrl(state) {
  const config = requireWechatOAuthConfig();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("appid", config.appId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "snsapi_login");
  url.searchParams.set("state", String(state));
  url.hash = "wechat_redirect";
  return url.toString();
}

async function fetchWechatJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WechatOAuthError("微信登录服务返回了无效响应", {
        code: "wechat-invalid-response",
      });
    }
    if (!response.ok || payload?.errcode) {
      throw new WechatOAuthError("微信登录授权失败，请重新扫码", {
        code: "wechat-provider-failed",
        providerCode: String(payload?.errcode ?? response.status),
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof WechatOAuthError) throw error;
    throw new WechatOAuthError("微信登录服务暂时不可用，请稍后重试", {
      code: "wechat-provider-unavailable",
      providerCode: String(error?.code ?? error?.name ?? ""),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeWechatCode(code, options = {}) {
  const normalizedCode = String(code ?? "").trim();
  if (!normalizedCode || normalizedCode.length > 512) {
    throw new WechatOAuthError("微信授权 code 无效", {
      code: "wechat-invalid-code",
      status: 400,
    });
  }
  const config = requireWechatOAuthConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenUrl = new URL(`${config.apiOrigin}/sns/oauth2/access_token`);
  tokenUrl.searchParams.set("appid", config.appId);
  tokenUrl.searchParams.set("secret", config.appSecret);
  tokenUrl.searchParams.set("code", normalizedCode);
  tokenUrl.searchParams.set("grant_type", "authorization_code");
  const token = await fetchWechatJson(tokenUrl, fetchImpl);
  const openid = String(token?.openid ?? "").trim();
  const accessToken = String(token?.access_token ?? "").trim();
  if (!openid || !accessToken || openid.length > 256 || accessToken.length > 2048) {
    throw new WechatOAuthError("微信登录凭证不完整", {
      code: "wechat-invalid-response",
    });
  }

  const userUrl = new URL(`${config.apiOrigin}/sns/userinfo`);
  userUrl.searchParams.set("access_token", accessToken);
  userUrl.searchParams.set("openid", openid);
  userUrl.searchParams.set("lang", "zh_CN");
  const profile = await fetchWechatJson(userUrl, fetchImpl);
  if (String(profile?.openid ?? "").trim() !== openid) {
    throw new WechatOAuthError("微信用户身份不一致", {
      code: "wechat-identity-mismatch",
    });
  }

  const unionid = String(profile?.unionid ?? token?.unionid ?? "").trim() || null;
  return {
    openid,
    unionid: unionid?.slice(0, 256) ?? null,
    nickname: String(profile?.nickname ?? "微信用户").trim().slice(0, 128) || "微信用户",
    avatarUrl: /^https:\/\//i.test(String(profile?.headimgurl ?? "").trim())
      ? String(profile.headimgurl).trim().slice(0, 2048)
      : null,
  };
}

export function getWechatFrontendRedirect(params = {}) {
  const config = requireWechatOAuthConfig();
  const url = new URL(config.frontendUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const tickets = new Map();

function pruneTickets(now = Date.now()) {
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(token);
  }
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (!oldest) break;
    tickets.delete(oldest);
  }
}

export function createWechatTicket(payload) {
  pruneTickets();
  const token = randomBytes(32).toString("base64url");
  tickets.set(token, { ...payload, expiresAt: Date.now() + TICKET_TTL_MS });
  return { token, expiresIn: Math.floor(TICKET_TTL_MS / 1000) };
}

export function getWechatTicket(token) {
  pruneTickets();
  const ticket = tickets.get(String(token ?? ""));
  return ticket ? { ...ticket } : null;
}

export function consumeWechatTicket(token) {
  const normalized = String(token ?? "");
  const ticket = getWechatTicket(normalized);
  if (ticket) tickets.delete(normalized);
  return ticket;
}

export function updateWechatTicket(token, patch) {
  const normalized = String(token ?? "");
  const current = getWechatTicket(normalized);
  if (!current) return null;
  const updated = { ...current, ...patch, expiresAt: current.expiresAt };
  tickets.set(normalized, updated);
  return { ...updated };
}

export function clearWechatTicket(token) {
  tickets.delete(String(token ?? ""));
}
