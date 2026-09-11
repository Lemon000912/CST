import test from "node:test";
import assert from "node:assert/strict";
import { buildWxLoginOptions } from "../src/wechatLoginOptionsRuntime.js";

test("WxLogin receives a URL-encoded redirect_uri", () => {
  const callback = "https://school.example.com/api/v1/auth/wechat/callback?source=qr login";
  const authorizationUrl = new URL("https://open.weixin.qq.com/connect/qrconnect");
  authorizationUrl.searchParams.set("appid", "wx-test-app");
  authorizationUrl.searchParams.set("redirect_uri", callback);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "snsapi_login");
  authorizationUrl.searchParams.set("state", "state-test");

  const options = buildWxLoginOptions(authorizationUrl.toString(), "wechat-login");

  assert.equal(options.appid, "wx-test-app");
  assert.equal(options.redirect_uri, encodeURIComponent(callback));
  assert.equal(options.state, "state-test");
});

test("WxLogin options reject an incomplete authorization URL", () => {
  assert.throws(
    () => buildWxLoginOptions("https://open.weixin.qq.com/connect/qrconnect?appid=wx-test-app", "wechat-login"),
    /Incomplete WeChat authorization URL/,
  );
});
