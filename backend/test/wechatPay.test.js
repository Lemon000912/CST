import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { BillingError } from "../billing.js";
import {
  createProviderOrder,
  PaymentProviderError,
  validateWechatPayConfig,
  verifyWechatNotification,
} from "../rechargeProviders.js";
import { createWechatPayRouter } from "../wechatPayRoutes.js";

const WECHAT_ENV_NAMES = [
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_MCH_SERIAL_NO",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_PRIVATE_KEY_PATH",
  "WECHAT_PAY_PUBLIC_KEY_PATH",
  "WECHAT_PAY_PUBLIC_KEY_ID",
  "WECHAT_PAY_NOTIFY_URL",
  "WECHAT_PAY_MERCHANT_SERIAL_NO",
  "WECHAT_PAY_PRIVATE_KEY",
  "WECHAT_PAY_PRIVATE_KEY_FILE",
  "WECHAT_PAY_PLATFORM_PUBLIC_KEY",
  "WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE",
  "WECHAT_PAY_PLATFORM_SERIAL_NO",
  "PAYMENT_NOTIFY_BASE_URL",
];

function saveEnvironment() {
  return Object.fromEntries(WECHAT_ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function installTestWechatConfig(directory, publicKey) {
  const publicKeyPath = path.join(directory, "pub_key.pem");
  const merchantKeyPath = path.join(directory, "apiclient_key.pem");
  const merchantPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(merchantKeyPath, merchantPair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  process.env.WECHAT_PAY_APP_ID = "wx-test-app";
  process.env.WECHAT_PAY_MCH_ID = "1900000001";
  process.env.WECHAT_PAY_MCH_SERIAL_NO = "MERCHANT-SERIAL-TEST";
  process.env.WECHAT_PAY_API_V3_KEY = "0123456789abcdef0123456789abcdef";
  process.env.WECHAT_PAY_PRIVATE_KEY_PATH = merchantKeyPath;
  process.env.WECHAT_PAY_PUBLIC_KEY_PATH = publicKeyPath;
  process.env.WECHAT_PAY_PUBLIC_KEY_ID = "PUB_KEY_ID_3000000001";
  process.env.WECHAT_PAY_NOTIFY_URL = "https://example.test/api/pay/wechat/notify";
}

function signedCallback(privateKey, overrides = {}) {
  const transaction = {
    appid: "wx-test-app",
    mchid: "1900000001",
    out_trade_no: "WX20260910101530AB12CD34",
    transaction_id: "4200000000000000000000000001",
    trade_state: "SUCCESS",
    amount: { total: 10_000, currency: "CNY" },
    ...overrides,
  };
  const nonce = "123456789012";
  const associatedData = "transaction";
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(process.env.WECHAT_PAY_API_V3_KEY),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(transaction)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const body = {
    id: "notification-test",
    event_type: "TRANSACTION.SUCCESS",
    resource: { ciphertext: encrypted, nonce, associated_data: associatedData },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headerNonce = "callback-nonce-test";
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${timestamp}\n${headerNonce}\n${rawBody.toString("utf8")}\n`), privateKey)
    .toString("base64");
  return {
    body,
    rawBody,
    headers: {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": headerNonce,
      "wechatpay-signature": signature,
      "wechatpay-serial": process.env.WECHAT_PAY_PUBLIC_KEY_ID,
    },
  };
}

test("missing API-v3 configuration reports exact variable names", () => {
  const saved = saveEnvironment();
  try {
    for (const name of WECHAT_ENV_NAMES) delete process.env[name];
    assert.throws(
      () => validateWechatPayConfig(),
      (error) => error instanceof PaymentProviderError
        && error.code === "payment-provider-not-configured"
        && /WECHAT_PAY_APP_ID/.test(error.message)
        && /WECHAT_PAY_PUBLIC_KEY_ID/.test(error.message),
    );
  } finally {
    restoreEnvironment(saved);
  }
});

test("callback signature, AppID, mchid, currency and transaction id are strictly validated", () => {
  const saved = saveEnvironment();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cst-wechat-callback-"));
  const wechatPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  try {
    installTestWechatConfig(directory, wechatPair.publicKey);
    const good = signedCallback(wechatPair.privateKey);
    assert.deepEqual(verifyWechatNotification(good), {
      paid: true,
      orderNo: "WX20260910101530AB12CD34",
      providerTransactionId: "4200000000000000000000000001",
      amountFen: 10_000,
    });

    assert.throws(
      () => verifyWechatNotification({ ...good, headers: { ...good.headers, "wechatpay-signature": "invalid" } }),
      (error) => error?.code === "invalid-payment-signature",
    );
    assert.throws(
      () => verifyWechatNotification(signedCallback(wechatPair.privateKey, { appid: "wrong-app" })),
      (error) => error?.code === "payment-appid-mismatch",
    );
    assert.throws(
      () => verifyWechatNotification(signedCallback(wechatPair.privateKey, { mchid: "wrong-mch" })),
      (error) => error?.code === "payment-mchid-mismatch",
    );
    assert.throws(
      () => verifyWechatNotification(signedCallback(wechatPair.privateKey, { amount: { total: 10_000, currency: "USD" } })),
      (error) => error?.code === "payment-currency-mismatch",
    );
    assert.throws(
      () => verifyWechatNotification(signedCallback(wechatPair.privateKey, { transaction_id: "" })),
      (error) => error?.code === "invalid-payment-notification",
    );
  } finally {
    restoreEnvironment(saved);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Native API-v3 request is server-priced, signed, and its response is verified", async () => {
  const saved = saveEnvironment();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cst-wechat-native-"));
  const wechatPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  try {
    installTestWechatConfig(directory, wechatPair.publicKey);
    let captured;
    const result = await createProviderOrder({
      provider: "wechat",
      orderNo: "WX20260910101530AB12CD34",
      amountFen: 10_000,
      description: "积分充值：1000 积分",
      fetchImpl: async (url, init) => {
        captured = { url, init, body: JSON.parse(init.body) };
        const raw = JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=verified" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = "response-nonce-test";
        const signature = crypto
          .sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), wechatPair.privateKey)
          .toString("base64");
        return new Response(raw, {
          status: 200,
          headers: {
            "Wechatpay-Timestamp": timestamp,
            "Wechatpay-Nonce": nonce,
            "Wechatpay-Signature": signature,
            "Wechatpay-Serial": process.env.WECHAT_PAY_PUBLIC_KEY_ID,
          },
        });
      },
    });
    assert.equal(captured.url, "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
    assert.equal(captured.body.amount.total, 10_000);
    assert.equal(captured.body.amount.currency, "CNY");
    assert.equal(captured.body.notify_url, "https://example.test/api/pay/wechat/notify");
    assert.match(captured.init.headers.Authorization, /^WECHATPAY2-SHA256-RSA2048 /);
    assert.equal(result.codeUrl, "weixin://wxpay/bizpayurl?pr=verified");
    assert.equal("Authorization" in result, false);
  } finally {
    restoreEnvironment(saved);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function withTestServer(dependencies, callback) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use("/api/pay/wechat", createWechatPayRouter(dependencies));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Native routes require login, accept only planId, and protect order ownership", async () => {
  const calls = [];
  const auth = (req, res, next) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "未登录" });
    req.auth = { userId: token };
    return next();
  };
  const order = {
    id: "order-id",
    orderNo: "WX20260910101530AB12CD34",
    provider: "wechat",
    packageId: "cny100_points1000",
    amountFen: 10_000,
    amountYuan: 100,
    points: 1_000,
    pointUnits: 20_000,
    status: "pending",
    codeUrl: "weixin://wxpay/bizpayurl?pr=route",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 900_000,
  };
  await withTestServer({
    requireAuthenticatedUser: auth,
    createOrder: async (input) => { calls.push(input); return order; },
    getOrderByNo: async ({ userId }) => {
      if (userId !== "owner") throw new BillingError("recharge-order-not-found", "充值订单不存在", 404);
      return order;
    },
  }, async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/api/pay/wechat/native`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: "cny100_points1000" }),
    });
    assert.equal(unauthenticated.status, 401);

    const created = await fetch(`${baseUrl}/api/pay/wechat/native`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ planId: "cny100_points1000", amount: 1 }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).amount, 10_000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].planId, "cny100_points1000");
    assert.equal(calls[0].provider, "wechat");
    assert.equal("amount" in calls[0], false);

    const forbidden = await fetch(`${baseUrl}/api/pay/wechat/orders/${order.orderNo}/status`, {
      headers: { Authorization: "Bearer other-user" },
    });
    assert.equal(forbidden.status, 404);
    const owned = await fetch(`${baseUrl}/api/pay/wechat/orders/${order.orderNo}/status`, {
      headers: { Authorization: "Bearer owner" },
    });
    assert.equal(owned.status, 200);
    assert.equal((await owned.json()).status, "PENDING");
  });
});

test("failed callback verification never invokes entitlement completion", async () => {
  let completions = 0;
  const auth = (_req, res) => res.status(401).end();
  await withTestServer({
    requireAuthenticatedUser: auth,
    verifyNotification: () => {
      throw new PaymentProviderError("invalid-payment-signature", "微信支付回调验签失败", 400);
    },
    completeOrder: async () => { completions += 1; },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/pay/wechat/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: {} }),
    });
    assert.equal(response.status, 400);
    assert.equal(completions, 0);
  });
});
