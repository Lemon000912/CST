// Browser integration tests using intercepted pages; no real accounts/network.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { EASTMONEY_LOGIN_URL, loginEastmoney } from "../backend/eastmoneyLogin.js";

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.EASTMONEY_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
  });
});
after(async () => { await browser?.close(); });

async function fixture(t, mode = "auto") {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  let authenticated = mode === "existing";
  const submissions = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "passport2.eastmoney.com") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: authenticated
        ? '<a href="/logout">退出</a><h1>个人中心</h1>'
        : '<iframe id="frame_login" src="https://exaccount2.eastmoney.com/form"></iframe>' });
    }
    if (url.pathname === "/authenticate") {
      submissions.push(route.request().postDataJSON());
      if (mode === "slow-sso" || mode === "redirect") await delay(700);
      if (mode !== "false-success") authenticated = true;
      return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    }
    if (url.hostname === "exaccount2.eastmoney.com" && url.pathname === "/form") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html>
        <span id="account-tab">账号登录</span>
        <input placeholder="邮箱/手机"><input placeholder="请输入登录密码" type="password">
        <img class="selectbox unselected" width="15" height="15" alt="同意协议">
        <img class="selectbox selected" width="15" height="15" alt="已同意协议" style="display:none">
        <button id="verify" style="display:none">点击开始验证</button>
        <span id="verified" style="display:none">验证成功</span>
        <span id="verified-duplicate" style="display:none">验证成功</span>
        <div id="status"></div><button id="login">登录</button>
        <script>
          let agreed = false, verified = false;
          const mode = ${JSON.stringify(mode)};
          const login = document.querySelector('#login');
          const status = document.querySelector('#status');
          document.querySelector('.unselected').onclick = () => {
            agreed = true;
            document.querySelector('.unselected').style.display = 'none';
            document.querySelector('.selected').style.display = '';
          };
          async function authenticate() {
            login.disabled = true;
            login.textContent = '登录中';
            await fetch('/authenticate', {method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({account:document.querySelector('input').value,
                password:document.querySelector('input[type=password]').value,agreed,verified})});
            status.textContent = '登录成功';
            if (mode === 'redirect') window.top.location.href = ${JSON.stringify(EASTMONEY_LOGIN_URL)};
          }
          login.onclick = () => {
            if (!agreed) { status.textContent = '请勾选协议'; return; }
            if (mode === 'wrong-password') { status.textContent = '账号或密码错误'; return; }
            if (!verified) { document.querySelector('#verify').style.display = ''; return; }
            authenticate();
          };
          function passVerification() {
            verified = true;
            document.querySelector('#verify').style.display = 'none';
            document.querySelector('#verified').style.display = '';
            if (mode === 'duplicate-verification') document.querySelector('#verified-duplicate').style.display = '';
            if (mode !== 'requires-submit' && mode !== 'duplicate-verification') authenticate();
          }
          document.querySelector('#verify').onclick = () => {
            if (mode === 'timeout') return;
            passVerification();
          };
        </script>` });
    }
    return route.abort();
  });
  return { page, submissions };
}

const credentials = { account: "fixture@example.com", password: " fixture-password " };
const options = { ...credentials, timeoutMs: 2000, verificationTimeoutMs: 4000 };

test("iframe login accepts agreement, verifies, and confirms personal-center session", async (t) => {
  const { page, submissions } = await fixture(t);
  const result = await loginEastmoney(page, options);
  assert.equal(result.loggedIn, true);
  assert.equal(await page.getByRole("link", { name: "退出", exact: true }).isVisible(), true);
  assert.deepEqual(submissions, [{ ...credentials, agreed: true, verified: true }]);
});

test("verification automatically clicks login when the site does not submit itself", async (t) => {
  const { page, submissions } = await fixture(t, "requires-submit");
  await loginEastmoney(page, options);
  assert.equal(submissions.length, 1);
});

test("duplicate visible verification-success labels do not abort login", async (t) => {
  const { page, submissions } = await fixture(t, "duplicate-verification");
  await loginEastmoney(page, options);
  assert.equal(submissions.length, 1);
  assert.equal(await page.getByRole("link", { name: "退出", exact: true }).isVisible(), true);
});

test("a pending login is allowed to finish its SSO request before session verification", async (t) => {
  const { page, submissions } = await fixture(t, "slow-sso");
  await loginEastmoney(page, options);
  assert.equal(submissions.length, 1);
  assert.equal(await page.getByRole("link", { name: "退出", exact: true }).isVisible(), true);
});

test("automatic personal-center navigation can detach the login frame", async (t) => {
  const { page, submissions } = await fixture(t, "redirect");
  await loginEastmoney(page, options);
  assert.equal(submissions.length, 1);
  assert.equal(await page.getByRole("link", { name: "退出", exact: true }).isVisible(), true);
});

test("incorrect credentials fail without returning the account or password", async (t) => {
  const { page, submissions } = await fixture(t, "wrong-password");
  await assert.rejects(loginEastmoney(page, options), /东方财富登录失败/);
  assert.equal(submissions.length, 0);
});

test("a success label without an authenticated session is rejected", async (t) => {
  const { page, submissions } = await fixture(t, "false-success");
  await assert.rejects(loginEastmoney(page, { ...options, timeoutMs: 800 }));
  assert.equal(submissions.length, 1);
  assert.equal(await page.getByRole("link", { name: "退出", exact: true }).isVisible(), false);
});

test("uncompleted verification times out instead of repeatedly submitting", async (t) => {
  const { page, submissions } = await fixture(t, "timeout");
  await assert.rejects(loginEastmoney(page, { ...options, verificationTimeoutMs: 600 }), /自动登录超时/);
  assert.equal(submissions.length, 0);
});

test("an existing personal-center session is reused", async (t) => {
  const { page, submissions } = await fixture(t, "existing");
  const result = await loginEastmoney(page, options);
  assert.equal(result.reusedSession, true);
  assert.equal(page.url(), EASTMONEY_LOGIN_URL);
  assert.equal(submissions.length, 0);
});
