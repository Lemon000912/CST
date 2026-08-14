import crypto from "node:crypto";
import fs from "node:fs";

const ALIPAY_DEFAULT_GATEWAY = "https://openapi.alipay.com/gateway.do";
const WECHAT_API_ORIGIN = "https://api.mch.weixin.qq.com";
const FETCH_TIMEOUT_MS = 15_000;

export class PaymentProviderError extends Error {
  constructor(code, message, status = 502, details = undefined) {
    super(message);
    this.name = "PaymentProviderError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function env(name) {
  return String(process.env[name] ?? "").trim();
}

function secretValue(name) {
  const inline = env(name);
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = env(`${name}_FILE`);
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new PaymentProviderError(
      "payment-secret-unreadable",
      `无法读取 ${name}_FILE 指定的密钥文件`,
      503,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function normalizeKey(value, kind) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.includes("-----BEGIN")) return raw;
  const lines = raw.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? raw;
  if (kind === "private") return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function notifyBaseUrl() {
  return env("PAYMENT_NOTIFY_BASE_URL").replace(/\/+$/, "");
}

export function getPaymentProviderAvailability() {
  const baseUrl = notifyBaseUrl();
  const alipay = Boolean(
    baseUrl &&
      env("ALIPAY_APP_ID") &&
      (env("ALIPAY_PRIVATE_KEY") || env("ALIPAY_PRIVATE_KEY_FILE")) &&
      (env("ALIPAY_PUBLIC_KEY") || env("ALIPAY_PUBLIC_KEY_FILE")),
  );
  const wechat = Boolean(
    baseUrl &&
      env("WECHAT_PAY_APP_ID") &&
      env("WECHAT_PAY_MCH_ID") &&
      env("WECHAT_PAY_MERCHANT_SERIAL_NO") &&
      (env("WECHAT_PAY_PRIVATE_KEY") || env("WECHAT_PAY_PRIVATE_KEY_FILE")) &&
      (env("WECHAT_PAY_PLATFORM_PUBLIC_KEY") || env("WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE")) &&
      env("WECHAT_PAY_API_V3_KEY"),
  );
  return { alipay, wechat };
}

function assertProviderConfigured(provider) {
  const available = getPaymentProviderAvailability();
  if (!available[provider]) {
    throw new PaymentProviderError(
      "payment-provider-not-configured",
      provider === "alipay" ? "支付宝扫码支付尚未配置" : "微信扫码支付尚未配置",
      503,
    );
  }
}

function signRsaSha256(content, privateKey) {
  return crypto.sign("RSA-SHA256", Buffer.from(content, "utf8"), privateKey).toString("base64");
}

function verifyRsaSha256(content, signature, publicKey) {
  try {
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(content, "utf8"),
      publicKey,
      Buffer.from(String(signature ?? ""), "base64"),
    );
  } catch {
    return false;
  }
}

export function alipayCanonicalize(params) {
  return Object.entries(params ?? {})
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== undefined && value !== null && String(value) !== "")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

export function parseCnyToFen(value) {
  const text = String(value ?? "").trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new PaymentProviderError("invalid-payment-amount", "支付金额格式无效", 400);
  const yuan = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const fen = yuan * 100 + cents;
  if (!Number.isSafeInteger(fen)) throw new PaymentProviderError("invalid-payment-amount", "支付金额超出范围", 400);
  return fen;
}

function formatFen(fen) {
  if (!Number.isSafeInteger(fen) || fen <= 0) throw new PaymentProviderError("invalid-payment-amount", "支付金额无效", 500);
  return `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;
}

function alipayTimestamp(now = new Date()) {
  const china = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return china.toISOString().slice(0, 19).replace("T", " ");
}

function extractJsonObjectField(raw, field) {
  const marker = `"${field}"`;
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return "";
  const colonIndex = raw.indexOf(":", markerIndex + marker.length);
  const start = raw.indexOf("{", colonIndex + 1);
  if (colonIndex < 0 || start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return "";
}

async function fetchWithPaymentTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "支付平台请求超时" : "无法连接支付平台";
    throw new PaymentProviderError("payment-provider-unavailable", message, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function createAlipayNativeOrder({ orderNo, amountFen, description }) {
  assertProviderConfigured("alipay");
  const privateKey = normalizeKey(secretValue("ALIPAY_PRIVATE_KEY"), "private");
  const params = {
    app_id: env("ALIPAY_APP_ID"),
    method: "alipay.trade.precreate",
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayTimestamp(),
    version: "1.0",
    notify_url: `${notifyBaseUrl()}/api/v1/billing/recharge/callback/alipay`,
    biz_content: JSON.stringify({
      out_trade_no: orderNo,
      total_amount: formatFen(amountFen),
      subject: description,
      timeout_express: "15m",
    }),
  };
  params.sign = signRsaSha256(alipayCanonicalize(params), privateKey);
  const response = await fetchWithPaymentTimeout(env("ALIPAY_GATEWAY_URL") || ALIPAY_DEFAULT_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params).toString(),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new PaymentProviderError("invalid-payment-provider-response", "支付宝返回了无法解析的响应", 502);
  }
  const result = payload?.alipay_trade_precreate_response;
  const signedResponse = extractJsonObjectField(raw, "alipay_trade_precreate_response");
  const alipayPublicKey = normalizeKey(secretValue("ALIPAY_PUBLIC_KEY"), "public");
  if (!payload?.sign || !signedResponse || !verifyRsaSha256(signedResponse, payload.sign, alipayPublicKey)) {
    throw new PaymentProviderError("invalid-payment-provider-signature", "支付宝下单响应验签失败", 502);
  }
  if (!response.ok || result?.code !== "10000" || !result?.qr_code) {
    throw new PaymentProviderError(
      "payment-order-create-failed",
      String(result?.sub_msg || result?.msg || `支付宝下单失败（HTTP ${response.status}）`),
      502,
      { providerCode: result?.sub_code || result?.code },
    );
  }
  return { codeUrl: String(result.qr_code), providerOrderId: result.trade_no ? String(result.trade_no) : null };
}

function wechatAuthorization({ method, path, body, privateKey }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signRsaSha256(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`, privateKey);
  const fields = {
    mchid: env("WECHAT_PAY_MCH_ID"),
    nonce_str: nonce,
    signature,
    timestamp,
    serial_no: env("WECHAT_PAY_MERCHANT_SERIAL_NO"),
  };
  return `WECHATPAY2-SHA256-RSA2048 ${Object.entries(fields)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",")}`;
}

function wechatExpireTime() {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function verifyWechatResponse(response, rawBody) {
  const timestamp = String(response.headers.get("wechatpay-timestamp") ?? "");
  const nonce = String(response.headers.get("wechatpay-nonce") ?? "");
  const signature = String(response.headers.get("wechatpay-signature") ?? "");
  const serial = String(response.headers.get("wechatpay-serial") ?? "");
  const expectedSerial = env("WECHAT_PAY_PLATFORM_SERIAL_NO");
  if (!timestamp || !nonce || !signature || !serial) {
    throw new PaymentProviderError("invalid-payment-provider-signature", "微信支付下单响应缺少签名", 502);
  }
  if (expectedSerial && serial.toUpperCase() !== expectedSerial.toUpperCase()) {
    throw new PaymentProviderError("payment-certificate-mismatch", "微信支付下单响应证书序列号不匹配", 502);
  }
  const publicKey = normalizeKey(secretValue("WECHAT_PAY_PLATFORM_PUBLIC_KEY"), "public");
  if (!verifyRsaSha256(`${timestamp}\n${nonce}\n${rawBody}\n`, signature, publicKey)) {
    throw new PaymentProviderError("invalid-payment-provider-signature", "微信支付下单响应验签失败", 502);
  }
}

async function createWechatNativeOrder({ orderNo, amountFen, description }) {
  assertProviderConfigured("wechat");
  const path = "/v3/pay/transactions/native";
  const privateKey = normalizeKey(secretValue("WECHAT_PAY_PRIVATE_KEY"), "private");
  const body = JSON.stringify({
    appid: env("WECHAT_PAY_APP_ID"),
    mchid: env("WECHAT_PAY_MCH_ID"),
    description,
    out_trade_no: orderNo,
    time_expire: wechatExpireTime(),
    notify_url: `${notifyBaseUrl()}/api/v1/billing/recharge/callback/wechat`,
    amount: { total: amountFen, currency: "CNY" },
  });
  const response = await fetchWithPaymentTimeout(`${WECHAT_API_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: wechatAuthorization({ method: "POST", path, body, privateKey }),
      "Content-Type": "application/json",
      "User-Agent": "quantum-pinnacle/1.0",
    },
    body,
  });
  const raw = await response.text();
  verifyWechatResponse(response, raw);
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new PaymentProviderError("invalid-payment-provider-response", "微信支付返回了无法解析的响应", 502);
  }
  if (!response.ok || !payload.code_url) {
    throw new PaymentProviderError(
      "payment-order-create-failed",
      String(payload.message || `微信支付下单失败（HTTP ${response.status}）`),
      502,
      { providerCode: payload.code },
    );
  }
  return { codeUrl: String(payload.code_url), providerOrderId: null };
}

export async function createProviderOrder({ provider, ...order }) {
  if (provider === "alipay") return createAlipayNativeOrder(order);
  if (provider === "wechat") return createWechatNativeOrder(order);
  throw new PaymentProviderError("unsupported-payment-provider", "不支持的支付方式", 400);
}

export function verifyAlipayNotification(params) {
  assertProviderConfigured("alipay");
  const signature = String(params?.sign ?? "");
  const publicKey = normalizeKey(secretValue("ALIPAY_PUBLIC_KEY"), "public");
  if (!signature || !verifyRsaSha256(alipayCanonicalize(params), signature, publicKey)) {
    throw new PaymentProviderError("invalid-payment-signature", "支付宝回调验签失败", 400);
  }
  if (String(params.app_id ?? "") !== env("ALIPAY_APP_ID")) {
    throw new PaymentProviderError("payment-merchant-mismatch", "支付宝应用 ID 不匹配", 400);
  }
  const expectedSeller = env("ALIPAY_SELLER_ID");
  if (expectedSeller && String(params.seller_id ?? "") !== expectedSeller) {
    throw new PaymentProviderError("payment-merchant-mismatch", "支付宝收款账号不匹配", 400);
  }
  const tradeStatus = String(params.trade_status ?? "");
  if (tradeStatus !== "TRADE_SUCCESS" && tradeStatus !== "TRADE_FINISHED") {
    return { paid: false, orderNo: String(params.out_trade_no ?? ""), tradeStatus };
  }
  return {
    paid: true,
    orderNo: String(params.out_trade_no ?? ""),
    providerTransactionId: String(params.trade_no ?? ""),
    amountFen: parseCnyToFen(params.total_amount),
  };
}

export function decryptWechatResource(resource, apiV3Key = env("WECHAT_PAY_API_V3_KEY")) {
  const key = Buffer.from(String(apiV3Key), "utf8");
  if (key.length !== 32) throw new PaymentProviderError("invalid-wechat-api-v3-key", "微信支付 APIv3 密钥必须为 32 字节", 503);
  const encrypted = Buffer.from(String(resource?.ciphertext ?? ""), "base64");
  if (encrypted.length <= 16) throw new PaymentProviderError("invalid-payment-notification", "微信支付回调密文无效", 400);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const authTag = encrypted.subarray(encrypted.length - 16);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(resource?.nonce ?? ""), "utf8"));
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(String(resource?.associated_data ?? ""), "utf8"));
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch {
    throw new PaymentProviderError("invalid-payment-notification", "微信支付回调解密失败", 400);
  }
}

export function verifyWechatNotification({ headers, rawBody, body }) {
  assertProviderConfigured("wechat");
  const timestamp = String(headers?.["wechatpay-timestamp"] ?? "");
  const nonce = String(headers?.["wechatpay-nonce"] ?? "");
  const signature = String(headers?.["wechatpay-signature"] ?? "");
  const serial = String(headers?.["wechatpay-serial"] ?? "");
  const expectedSerial = env("WECHAT_PAY_PLATFORM_SERIAL_NO");
  if (!timestamp || !nonce || !signature || !serial || !rawBody) {
    throw new PaymentProviderError("invalid-payment-notification", "微信支付回调头不完整", 400);
  }
  const callbackTime = Number(timestamp);
  if (!Number.isSafeInteger(callbackTime) || Math.abs(Math.floor(Date.now() / 1000) - callbackTime) > 300) {
    throw new PaymentProviderError("stale-payment-notification", "微信支付回调时间戳无效", 400);
  }
  if (expectedSerial && serial.toUpperCase() !== expectedSerial.toUpperCase()) {
    throw new PaymentProviderError("payment-certificate-mismatch", "微信支付平台证书序列号不匹配", 400);
  }
  const publicKey = normalizeKey(secretValue("WECHAT_PAY_PLATFORM_PUBLIC_KEY"), "public");
  const rawText = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  if (!verifyRsaSha256(`${timestamp}\n${nonce}\n${rawText}\n`, signature, publicKey)) {
    throw new PaymentProviderError("invalid-payment-signature", "微信支付回调验签失败", 400);
  }
  const decrypted = decryptWechatResource(body?.resource);
  if (String(decrypted.appid ?? "") !== env("WECHAT_PAY_APP_ID") || String(decrypted.mchid ?? "") !== env("WECHAT_PAY_MCH_ID")) {
    throw new PaymentProviderError("payment-merchant-mismatch", "微信支付商户信息不匹配", 400);
  }
  if (String(decrypted.trade_state ?? "") !== "SUCCESS") {
    return { paid: false, orderNo: String(decrypted.out_trade_no ?? ""), tradeStatus: String(decrypted.trade_state ?? "") };
  }
  return {
    paid: true,
    orderNo: String(decrypted.out_trade_no ?? ""),
    providerTransactionId: String(decrypted.transaction_id ?? ""),
    amountFen: Number(decrypted.amount?.total),
  };
}
