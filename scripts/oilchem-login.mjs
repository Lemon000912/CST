#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { loginOilchem } from "../backend/oilchemLogin.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log(`用法：npm run oilchem:login -- [--headless] [--close]
环境变量：OILCHEM_ACCOUNT、OILCHEM_PASSWORD
可选：OILCHEM_BROWSER_CHANNEL（Windows 默认 msedge，其它系统默认 chromium）
      OILCHEM_LOGIN_TIMEOUT_MS（登录等待时间，默认 30000 毫秒）
自动切换账号登录，填写账号密码，勾选协议及记住密码并登录。
默认保留浏览器窗口；--close 或 --headless 在运行结束后自动关闭。`);
  process.exit(0);
}
if ([...args].some((arg) => !["--headless", "--close"].includes(arg))) {
  console.error("存在未知参数，请使用 --help 查看用法。");
  process.exit(1);
}

let browser;
try {
  if (!process.env.OILCHEM_ACCOUNT?.trim() || !process.env.OILCHEM_PASSWORD) {
    throw new Error("请在 .env.local 或环境变量中配置 OILCHEM_ACCOUNT 和 OILCHEM_PASSWORD。");
  }
  const channel = process.env.OILCHEM_BROWSER_CHANNEL?.trim()
    || (process.platform === "win32" ? "msedge" : "chromium");
  try {
    browser = await chromium.launch({ channel, headless: args.has("--headless") });
  } catch {
    throw new Error("无法启动浏览器。请安装 Microsoft Edge，或安装 Playwright Chromium 并设置 OILCHEM_BROWSER_CHANNEL=chromium。");
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginOilchem(page, {
    account: process.env.OILCHEM_ACCOUNT,
    password: process.env.OILCHEM_PASSWORD,
    loginTimeoutMs: process.env.OILCHEM_LOGIN_TIMEOUT_MS,
    onStatus: (message) => console.log(`[oilchem] ${message}`),
  });
  console.log("隆众资讯登录成功，已确认会员中心及退出入口。");
} catch (error) {
  // Never print raw Playwright errors: fill diagnostics may include credentials.
  const message = String(error?.message ?? "");
  const safe = /^(请在|隆众资讯登录失败|隆众资讯自动登录超时|隆众资讯登录窗口已关闭|隆众资讯登录超时参数|无法启动浏览器)/.test(message);
  const detail = /strict mode violation/.test(message) ? "页面控件匹配不唯一"
    : /Timeout|timeout|TimeoutError/.test(message) ? "等待页面控件超时"
      : /ERR_|net::/.test(message) ? "网络连接失败"
        : /closed|detached|destroyed/i.test(message) ? "页面在登录过程中关闭或跳转" : "页面操作失败";
  console.error(safe ? message : `隆众资讯登录未完成：${detail}。`);
  process.exitCode = 1;
} finally {
  if (browser?.isConnected()) {
    if (args.has("--headless") || args.has("--close")) {
      await browser.close();
    } else {
      console.log("浏览器保持打开，可直接使用或查看当前状态；关闭浏览器窗口后脚本退出。");
      const closeOnInterrupt = () => { void browser.close(); };
      process.once("SIGINT", closeOnInterrupt);
      await new Promise((resolve) => browser.once("disconnected", resolve));
      process.removeListener("SIGINT", closeOnInterrupt);
    }
  }
}
