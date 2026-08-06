#!/usr/bin/env node
/**
 * Dataify 通用采集 API 联调（https://webunlocker.dataify.com/request）
 * 用法：node scripts/dataify-webunlocker-test.mjs [目标URL]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDataifyWebUnlockerHtml, getDataifyWebUnlockerConfig } from "../backend/dataifyWebUnlocker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const target = process.argv[2] || "https://example.com";
const cfg = getDataifyWebUnlockerConfig();
if (!cfg) {
  console.error("请在 .env 设置 DATAIFY_API_KEY，且 DATAIFY_WEBUNLOCKER_ENABLED 未关闭");
  process.exit(1);
}

const got = await fetchDataifyWebUnlockerHtml(target, cfg);
console.log("URL:", cfg.requestUrl);
console.log("Target:", target);
console.log("OK:", got.ok);
if (!got.ok) {
  console.error("Error:", got.error);
  process.exit(1);
}
console.log("Final URL:", got.finalUrl);
console.log("HTML length:", got.html.length);
console.log("Preview:", got.html.replace(/\s+/g, " ").slice(0, 280));
