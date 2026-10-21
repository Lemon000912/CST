// Browser integration tests with intercepted pages; no real accounts/network.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { loginOilchem } from "../backend/oilchemLogin.js";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true,
    channel: process.env.OILCHEM_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium") });
});
after(async () => { await browser?.close(); });

async function fixture(t, mode = "normal") {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const submissions = [];
  let authenticated = mode === "existing";
  const home = '<a href="/member">[会员中心]</a><a href="/logout">[退出]</a>';
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/authenticate") {
      submissions.push(route.request().postDataJSON());
      if (mode === "slow") await delay(650);
      authenticated = mode !== "wrong-password" && mode !== "false-success";
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: mode !== "wrong-password" }) });
    }
    if (url.hostname === "www.oilchem.net") {
      return route.fulfill({ contentType: "text/html; charset=utf-8",
        body: authenticated ? home : '<a href="/member">[会员中心]</a><div>登录成功</div>' });
    }
    if (authenticated) return route.fulfill({ contentType: "text/html; charset=utf-8", body: home });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html>
      <span id="account-tab">账号登录</span>
      <div style="display:none"><input type="checkbox" id="sms-agreement"></div>
      <div id="account" style="display:none">
        <input placeholder="请输入用户名"><input type="password" placeholder="请输入密码">
        <label><input type="checkbox" id="agreement" ${mode === "checked" ? "checked" : ""}>我已阅读并接受隆众资讯</label>
        <label><input type="checkbox" id="remberId" ${mode === "checked" ? "checked" : ""}>记住密码</label>
        <button>登 录</button><div id="error"></div>
      </div>
      <script>
        document.querySelector('#account-tab').onclick=()=>document.querySelector('#account').style.display='';
        document.querySelector('button').onclick=async()=>{
          const button=document.querySelector('button');
          button.disabled=true;
          const response=await fetch('/authenticate',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({account:document.querySelector('input[placeholder="请输入用户名"]').value,
              password:document.querySelector('input[type=password]').value,
              agreement:document.querySelector('#agreement').checked,remember:document.querySelector('#remberId').checked})});
          const result=await response.json();
          if(!result.ok){document.querySelector('#error').textContent='用户名或密码错误';return;}
          if(${JSON.stringify(mode)}==='timeout')return;
          location.href='https://www.oilchem.net/';
        };
      </script>` });
  });
  return { page, submissions };
}

const credentials = { account: "oilchem-fixture", password: " fixture-password " };
const options = { ...credentials, timeoutMs: 2000, loginTimeoutMs: 2500 };

test("fills credentials, checks both boxes, and verifies the redirected home page", async (t) => {
  const { page, submissions } = await fixture(t);
  const result = await loginOilchem(page, options);
  assert.equal(result.loggedIn, true);
  assert.equal(result.reusedSession, false);
  assert.equal(new URL(page.url()).hostname, "www.oilchem.net");
  assert.deepEqual(submissions, [{ ...credentials, agreement: true, remember: true }]);
});

test("already-checked agreement and remember boxes remain checked", async (t) => {
  const { page, submissions } = await fixture(t, "checked");
  await loginOilchem(page, options);
  assert.equal(submissions[0].agreement, true);
  assert.equal(submissions[0].remember, true);
});

test("a delayed login redirect is awaited without submitting again", async (t) => {
  const { page, submissions } = await fixture(t, "slow");
  await loginOilchem(page, options);
  assert.equal(submissions.length, 1);
});

test("wrong credentials fail with a safe message", async (t) => {
  const { page, submissions } = await fixture(t, "wrong-password");
  await assert.rejects(loginOilchem(page, options), /隆众资讯登录失败/);
  assert.equal(submissions.length, 1);
});

test("a success message and member link without a logout link are insufficient", async (t) => {
  const { page, submissions } = await fixture(t, "false-success");
  await assert.rejects(loginOilchem(page, { ...options, loginTimeoutMs: 700 }), /隆众资讯自动登录超时/);
  assert.equal(submissions.length, 1);
});

test("an unresolved login times out without repeated password submissions", async (t) => {
  const { page, submissions } = await fixture(t, "timeout");
  await assert.rejects(loginOilchem(page, { ...options, loginTimeoutMs: 700 }), /隆众资讯自动登录超时/);
  assert.equal(submissions.length, 1);
});

test("an authenticated session is reused without submitting credentials", async (t) => {
  const { page, submissions } = await fixture(t, "existing");
  assert.equal((await loginOilchem(page, options)).reusedSession, true);
  assert.equal(submissions.length, 0);
});
