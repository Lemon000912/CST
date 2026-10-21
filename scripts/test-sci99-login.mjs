// Browser integration tests with intercepted pages; no real accounts/network.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { loginSci99 } from "../backend/sci99Login.js";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true,
    channel: process.env.SCI99_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium") });
});
after(async () => { await browser?.close(); });

const credentials = { account: "sci99-fixture", password: " fixture-password " };
const options = { ...credentials, timeoutMs: 2000, loginTimeoutMs: 2500 };

async function fixture(t, mode = "normal") {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const submissions = [];
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/authenticate") {
      submissions.push(route.request().postDataJSON());
      if (mode === "slow") await delay(650);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: mode !== "wrong-password" }) });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html>
      <style>
        .el-checkbox__input{position:relative;display:inline-block;width:18px;height:18px}
        .el-checkbox__inner{position:absolute;inset:0;border:1px solid #888;z-index:1;cursor:pointer}
        .el-checkbox__original{position:absolute;width:16px;height:16px;opacity:0;pointer-events:none}
      </style>
      <div id="app">
        <span id="account-tab">账号密码登录</span>
        <div style="display:none"><span class="el-checkbox__inner"></span></div>
        <div id="account" style="display:none">
          <input placeholder="请输入账号"><input placeholder="请输入密码" type="password">
          <span class="el-checkbox__input"><span class="el-checkbox__inner" id="agreement-icon"></span>
            <input type="checkbox" aria-hidden="true" class="el-checkbox__original" ${mode === "checked" ? "checked" : ""}></span>
          <span>我已阅读并同意</span><button>登录</button><div id="error"></div>
        </div>
      </div>
      <script>
        const mode=${JSON.stringify(mode)};
        function showCenter(account,withGreeting=true){
          location.hash='/subscribeList';
          document.querySelector('#app').innerHTML=(withGreeting?'<button>您好，'+account+'</button>':'<div>登录成功</div>')
            +'<div role="menubar"><div role="menuitem">工作台 ▼</div></div>';
        }
        document.querySelector('#account-tab').onclick=()=>document.querySelector('#account').style.display='';
        document.querySelector('#agreement-icon').onclick=()=>{
          if(mode==='broken-agreement')return;
          const input=document.querySelector('input[type=checkbox]');input.checked=!input.checked;
        };
        document.querySelector('button').onclick=async()=>{
          document.querySelector('button').disabled=true;
          const result=await(await fetch('/authenticate',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({account:document.querySelector('input[placeholder="请输入账号"]').value,
              password:document.querySelector('input[type=password]').value,
              agreement:document.querySelector('input[type=checkbox]').checked})})).json();
          if(!result.ok){document.querySelector('#error').textContent='账号或密码错误';return;}
          if(mode==='timeout')return;
          showCenter(${JSON.stringify(credentials.account)},mode!=='false-success');
        };
        if(mode==='existing')showCenter(${JSON.stringify(credentials.account)});
        if(mode==='different-account')showCenter('another-fixture');
      </script>` });
  });
  return { page, submissions };
}

test("switches to account mode, checks the custom agreement icon, and verifies SPA login", async (t) => {
  const { page, submissions } = await fixture(t);
  const result = await loginSci99(page, options);
  assert.equal(result.loggedIn, true);
  assert.equal(result.reusedSession, false);
  assert.equal(new URL(page.url()).hash, "#/subscribeList");
  assert.deepEqual(submissions, [{ ...credentials, agreement: true }]);
});

test("an already-selected custom checkbox is not toggled off", async (t) => {
  const { page, submissions } = await fixture(t, "checked");
  await loginSci99(page, options);
  assert.equal(submissions[0].agreement, true);
});

test("a failed agreement toggle prevents credential submission", async (t) => {
  const { page, submissions } = await fixture(t, "broken-agreement");
  await assert.rejects(loginSci99(page, options), /卓创资讯协议勾选未生效/);
  assert.equal(submissions.length, 0);
});

test("a delayed SPA login is awaited without submitting again", async (t) => {
  const { page, submissions } = await fixture(t, "slow");
  await loginSci99(page, options);
  assert.equal(submissions.length, 1);
});

test("wrong credentials fail with a safe message", async (t) => {
  const { page, submissions } = await fixture(t, "wrong-password");
  await assert.rejects(loginSci99(page, options), /卓创资讯登录失败/);
  assert.equal(submissions.length, 1);
});

test("a route change and workbench without the user's greeting are insufficient", async (t) => {
  const { page, submissions } = await fixture(t, "false-success");
  await assert.rejects(loginSci99(page, { ...options, loginTimeoutMs: 700 }), /卓创资讯自动登录超时/);
  assert.equal(submissions.length, 1);
});

test("unconfirmed login times out without repeated password submissions", async (t) => {
  const { page, submissions } = await fixture(t, "timeout");
  await assert.rejects(loginSci99(page, { ...options, loginTimeoutMs: 700 }), /卓创资讯自动登录超时/);
  assert.equal(submissions.length, 1);
});

test("an authenticated session for the configured account is reused", async (t) => {
  const { page, submissions } = await fixture(t, "existing");
  assert.equal((await loginSci99(page, options)).reusedSession, true);
  assert.equal(submissions.length, 0);
});

test("an existing session for another account is rejected", async (t) => {
  const { page, submissions } = await fixture(t, "different-account");
  await assert.rejects(loginSci99(page, options), /卓创资讯当前会话与配置账号不一致/);
  assert.equal(submissions.length, 0);
});
