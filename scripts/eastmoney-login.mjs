#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { loginEastmoney } from "../backend/eastmoneyLogin.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log(`用法：npm run eastmoney:login -- [--headless] [--close]
环境变量：EASTMONEY_ACCOUNT、EASTMONEY_PASSWORD
可选：EASTMONEY_BROWSER_CHANNEL（Windows 默认 msedge，其它系统默认 chromium）
      EASTMONEY_VERIFY_TIMEOUT_MS（自动验证超时，默认 30000 毫秒）
自动填写、勾选协议、点击开始验证并完成登录；默认保持浏览器打开。
--close 或 --headless：运行结束后自动关闭浏览器。
验证未自动通过时超时报错，不进入人工处理流程。`);
  process.exit(0);
}
const unknown = [...args].filter((arg) => !["--headless", "--close"].includes(arg));
if (unknown.length) {
  console.error("存在未知参数，请使用 --help 查看用法。");
  process.exit(1);
}

let browser;
try {
  if (!process.env.EASTMONEY_ACCOUNT?.trim() || !process.env.EASTMONEY_PASSWORD) {
    throw new Error("请在 .env.local 或环境变量中配置 EASTMONEY_ACCOUNT 和 EASTMONEY_PASSWORD。");
  }
  const channel = process.env.EASTMONEY_BROWSER_CHANNEL?.trim()
    || (process.platform === "win32" ? "msedge" : "chromium");
  try {
    browser = await chromium.launch({ headless: args.has("--headless"), channel });
  } catch {
    throw new Error("无法启动浏览器。请安装 Microsoft Edge，或运行 npx playwright install chromium 并设置 EASTMONEY_BROWSER_CHANNEL=chromium。");
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginEastmoney(page, {
    account: process.env.EASTMONEY_ACCOUNT,
    password: process.env.EASTMONEY_PASSWORD,
    verificationTimeoutMs: process.env.EASTMONEY_VERIFY_TIMEOUT_MS,
    onStatus: (message) => console.log(`[eastmoney] ${message}`),
  });
  console.log("东方财富登录成功，已确认个人中心的退出入口。");
} catch (error) {
  // Playwright diagnostics can include fill arguments. Never print raw errors.
  const message = String(error?.message ?? "");
  const safe = /^(请在|未找到东方财富登录表单|东方财富登录失败|自动登录超时|登录窗口已关闭|登录超时参数|无法启动浏览器)/.test(message);
  const detail = /strict mode violation/.test(message) ? "页面控件匹配不唯一"
    : /Timeout|timeout|TimeoutError/.test(message) ? "等待页面控件超时"
      : /ERR_|net::/.test(message) ? "网络连接失败"
        : /closed|detached|destroyed/i.test(message) ? "页面在登录过程中关闭或跳转"
          : "页面操作失败";
  console.error(safe ? message : `东方财富登录未完成：${detail}。`);
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
