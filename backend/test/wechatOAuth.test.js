import test from "node:test";
import assert from "node:assert/strict";
import {
  WechatOAuthError,
  buildWechatEnterpriseCallbackRelayUrl,
  buildWechatAuthorizationUrl,
  consumeWechatTicket,
  createWechatOAuthState,
  createWechatTicket,
  exchangeWechatCode,
  getWechatOAuthStateCookieDomain,
  getWechatOAuthStateEdition,
  getWechatTicket,
  isWechatOAuthConfigured,
  updateWechatTicket,
} from "../wechatOAuth.js";

const ENV_KEYS = [
  "APP_EDITION",
  "NODE_ENV",
  "WECHAT_OPEN_APP_ID",
  "WECHAT_OPEN_APP_SECRET",
  "WECHAT_OPEN_REDIRECT_URI",
  "WECHAT_OPEN_FRONTEND_URL",
  "WECHAT_OPEN_AUTHORIZE_URL",
  "WECHAT_OPEN_API_ORIGIN",
  "WECHAT_OPEN_COOKIE_DOMAIN",
  "WECHAT_OPEN_ENTERPRISE_CALLBACK_URI",
  "SCHOOL_WECHAT_OPEN_APP_ID",
  "SCHOOL_WECHAT_OPEN_APP_SECRET",
  "SCHOOL_WECHAT_OPEN_REDIRECT_URI",
  "SCHOOL_WECHAT_OPEN_FRONTEND_URL",
  "ENTERPRISE_WECHAT_OPEN_APP_ID",
  "ENTERPRISE_WECHAT_OPEN_APP_SECRET",
  "ENTERPRISE_WECHAT_OPEN_REDIRECT_URI",
  "ENTERPRISE_WECHAT_OPEN_FRONTEND_URL",
];

function configuredEnv(t) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "test",
    WECHAT_OPEN_APP_ID: "wx-test-app",
    WECHAT_OPEN_APP_SECRET: "secret-test-value",
    WECHAT_OPEN_REDIRECT_URI: "https://example.test/api/v1/auth/wechat/callback",
    WECHAT_OPEN_FRONTEND_URL: "https://example.test/",
    WECHAT_OPEN_AUTHORIZE_URL: "https://open.weixin.qq.com/connect/qrconnect",
    WECHAT_OPEN_API_ORIGIN: "https://api.weixin.qq.com",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test("WeChat website OAuth URL uses snsapi_login and an exact callback", (t) => {
  configuredEnv(t);
  assert.equal(isWechatOAuthConfigured(), true);
  const url = new URL(buildWechatAuthorizationUrl("state-test-1234567890"));
  assert.equal(url.origin, "https://open.weixin.qq.com");
  assert.equal(url.searchParams.get("appid"), "wx-test-app");
  assert.equal(url.searchParams.get("scope"), "snsapi_login");
  assert.equal(url.searchParams.get("state"), "state-test-1234567890");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://example.test/api/v1/auth/wechat/callback",
  );
  assert.equal(url.toString().includes("secret-test-value"), false);
});

test("one shared env can provide edition-specific WeChat OAuth settings", (t) => {
  configuredEnv(t);
  Object.assign(process.env, {
    APP_EDITION: "enterprise",
    ENTERPRISE_WECHAT_OPEN_APP_ID: "wx-enterprise-app",
    ENTERPRISE_WECHAT_OPEN_APP_SECRET: "enterprise-secret",
    ENTERPRISE_WECHAT_OPEN_REDIRECT_URI: "https://enterprise.example.test/api/v1/auth/wechat/callback",
    ENTERPRISE_WECHAT_OPEN_FRONTEND_URL: "https://enterprise.example.test/",
  });

  const url = new URL(buildWechatAuthorizationUrl("enterprise-state"));
  assert.equal(url.searchParams.get("appid"), "wx-enterprise-app");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://enterprise.example.test/api/v1/auth/wechat/callback",
  );
});

test("cross-subdomain enterprise login uses a bounded state and shared parent cookie", (t) => {
  configuredEnv(t);
  Object.assign(process.env, {
    APP_EDITION: "enterprise",
    ENTERPRISE_WECHAT_OPEN_REDIRECT_URI: "https://login.example.test/api/v1/auth/wechat/callback",
    ENTERPRISE_WECHAT_OPEN_FRONTEND_URL: "https://enterprise.login.example.test/",
    WECHAT_OPEN_COOKIE_DOMAIN: "login.example.test",
  });

  const state = createWechatOAuthState("enterprise");
  assert.match(state, /^enterprise\.[A-Za-z0-9_-]{32}$/);
  assert.equal(getWechatOAuthStateEdition(state), "enterprise");
  assert.equal(getWechatOAuthStateEdition(`enterprise.${"x".repeat(31)}`), null);
  assert.equal(getWechatOAuthStateEdition(`https://evil.test/${"x".repeat(32)}`), null);
  assert.equal(getWechatOAuthStateCookieDomain(), "login.example.test");
});

test("enterprise callback relay is fixed by server configuration", (t) => {
  configuredEnv(t);
  process.env.WECHAT_OPEN_ENTERPRISE_CALLBACK_URI = "https://enterprise.example.test/api/v1/auth/wechat/callback";

  const relayUrl = new URL(buildWechatEnterpriseCallbackRelayUrl({
    code: "temporary code",
    state: `enterprise.${"x".repeat(32)}`,
    redirect_uri: "https://evil.test/",
  }));
  assert.equal(relayUrl.origin, "https://enterprise.example.test");
  assert.equal(relayUrl.searchParams.get("code"), "temporary code");
  assert.equal(relayUrl.searchParams.get("state"), `enterprise.${"x".repeat(32)}`);
  assert.equal(relayUrl.searchParams.has("redirect_uri"), false);
});

test("WeChat OAuth exchanges code server-side and returns only normalized identity", async (t) => {
  configuredEnv(t);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return jsonResponse({
        access_token: "access-test",
        openid: "openid-test",
        unionid: "unionid-test",
      });
    }
    return jsonResponse({
      openid: "openid-test",
      unionid: "unionid-test",
      nickname: "犀材用户",
      headimgurl: "https://example.test/avatar.png",
    });
  };
  const identity = await exchangeWechatCode("temporary-code", { fetchImpl });
  assert.deepEqual(identity, {
    openid: "openid-test",
    unionid: "unionid-test",
    nickname: "犀材用户",
    avatarUrl: "https://example.test/avatar.png",
  });
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0]).searchParams.get("secret"), "secret-test-value");
  assert.equal(new URL(requests[1]).searchParams.get("access_token"), "access-test");
  assert.equal(JSON.stringify(identity).includes("access-test"), false);
});

test("WeChat provider errors are bounded and do not expose secrets", async (t) => {
  configuredEnv(t);
  await assert.rejects(
    exchangeWechatCode("bad-code", {
      fetchImpl: async () => jsonResponse({ errcode: 40029, errmsg: "invalid code" }),
    }),
    (error) => error instanceof WechatOAuthError
      && error.code === "wechat-provider-failed"
      && error.providerCode === "40029"
      && !error.message.includes("secret-test-value"),
  );
});

test("WeChat login tickets are short-lived, updateable, and single-use", () => {
  const created = createWechatTicket({ kind: "bind", identity: { openid: "openid-ticket" } });
  assert.ok(created.token.length >= 32);
  assert.equal(getWechatTicket(created.token)?.kind, "bind");
  assert.equal(updateWechatTicket(created.token, { verifiedPhone: "13800138000" })?.verifiedPhone, "13800138000");
  assert.equal(consumeWechatTicket(created.token)?.verifiedPhone, "13800138000");
  assert.equal(getWechatTicket(created.token), null);
});
