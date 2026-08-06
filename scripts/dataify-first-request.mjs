#!/usr/bin/env node
/**
 * Dataify 网页采集 API 首请求（官方文档：https://doc.dataify.com/8577814m0）
 * 用法：node scripts/dataify-first-request.mjs
 * 需 .env 中 DATAIFY_API_KEY；可选 DATAIFY_SCRAPER_URL（默认 scraperapi.dataify.com/builder）
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const token = String(process.env.DATAIFY_API_KEY ?? "").trim();
const url =
  String(process.env.DATAIFY_SCRAPER_URL ?? "").trim() ||
  "https://scraperapi.dataify.com/builder";

if (!token) {
  console.error("请在 .env 设置 DATAIFY_API_KEY");
  process.exit(1);
}

const body = new URLSearchParams({
  spider_name: "amazon.com",
  spider_id: "amazon_product_by-asin",
  spider_parameters: JSON.stringify([{ asin: "B0BZYCJK89" }]),
  spider_errors: "true",
  file_name: `task-${Date.now()}`,
});

const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body,
});

const text = await res.text();
console.log("URL:", url);
console.log("HTTP", res.status);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}

if (!res.ok) process.exit(1);
