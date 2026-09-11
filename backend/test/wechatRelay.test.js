import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.NODE_ENV = "test";
process.env.WECHAT_OPEN_APP_ID = "wx-shared-app";
process.env.WECHAT_OPEN_APP_SECRET = "shared-secret";
process.env.WECHAT_OPEN_COOKIE_DOMAIN = "syncsee.example.test";
process.env.WECHAT_OPEN_ENTERPRISE_CALLBACK_URI = "https://enterprise.syncsee.example.test/api/v1/auth/wechat/callback";
process.env.SCHOOL_WECHAT_OPEN_REDIRECT_URI = "https://syncsee.example.test/api/v1/auth/wechat/callback";
process.env.SCHOOL_WECHAT_OPEN_FRONTEND_URL = "https://syncsee.example.test/";
process.env.ENTERPRISE_WECHAT_OPEN_REDIRECT_URI = "https://syncsee.example.test/api/v1/auth/wechat/callback";
process.env.ENTERPRISE_WECHAT_OPEN_FRONTEND_URL = "https://enterprise.syncsee.example.test/";

const { handleWechatCallback, handleWechatStart } = await import("../auth.js");

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    redirects: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    append(name, value) {
      const current = this.headers[name];
      this.headers[name] = current ? [].concat(current, value) : value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(status, url) {
      this.statusCode = status;
      this.redirects.push(url);
      return this;
    },
  };
}

test("enterprise login starts on the shared callback domain with a parent-domain state cookie", async () => {
  process.env.APP_EDITION = "enterprise";
  const response = responseCapture();
  await handleWechatStart({ query: { display: "embed" } }, response);

  assert.equal(response.statusCode, 200);
  const authorizationUrl = new URL(response.body.authorizationUrl);
  const state = authorizationUrl.searchParams.get("state");
  assert.equal(
    authorizationUrl.searchParams.get("redirect_uri"),
    "https://syncsee.example.test/api/v1/auth/wechat/callback",
  );
  assert.match(state, /^enterprise\.[A-Za-z0-9_-]{32}$/);
  assert.match(String(response.headers["Set-Cookie"]), /qp_wechat_oauth_state_enterprise=/);
  assert.match(String(response.headers["Set-Cookie"]), /Domain=syncsee\.example\.test/);
});

test("the shared school callback relays enterprise state only to the configured enterprise callback", async () => {
  process.env.APP_EDITION = "school";
  const response = responseCapture();
  const state = `enterprise.${"x".repeat(32)}`;
  await handleWechatCallback({ query: { code: "temporary-code", state } }, response);

  assert.equal(response.statusCode, 302);
  assert.equal(response.redirects.length, 1);
  const relayUrl = new URL(response.redirects[0]);
  assert.equal(relayUrl.origin, "https://enterprise.syncsee.example.test");
  assert.equal(relayUrl.pathname, "/api/v1/auth/wechat/callback");
  assert.equal(relayUrl.searchParams.get("code"), "temporary-code");
  assert.equal(relayUrl.searchParams.get("state"), state);
});
