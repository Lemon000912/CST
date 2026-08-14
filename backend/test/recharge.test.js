import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { RECHARGE_PACKAGE } from "../recharge.js";
import {
  alipayCanonicalize,
  decryptWechatResource,
  parseCnyToFen,
  verifyAlipayNotification,
} from "../rechargeProviders.js";

test("recharge package is exactly 100 yuan for 1000 points", () => {
  assert.deepEqual(RECHARGE_PACKAGE, {
    id: "cny100_points1000",
    amountFen: 10_000,
    amountYuan: 100,
    points: 1_000,
    pointUnits: 20_000,
  });
});

test("CNY amounts are parsed without floating point rounding", () => {
  assert.equal(parseCnyToFen("100"), 10_000);
  assert.equal(parseCnyToFen("100.0"), 10_000);
  assert.equal(parseCnyToFen("100.00"), 10_000);
  assert.equal(parseCnyToFen("0.05"), 5);
  assert.throws(() => parseCnyToFen("100.001"), /金额格式无效/);
  assert.throws(() => parseCnyToFen("1e2"), /金额格式无效/);
});

test("Alipay callback verification uses sorted RSA2 canonical parameters", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const saved = {
    PAYMENT_NOTIFY_BASE_URL: process.env.PAYMENT_NOTIFY_BASE_URL,
    ALIPAY_APP_ID: process.env.ALIPAY_APP_ID,
    ALIPAY_PRIVATE_KEY: process.env.ALIPAY_PRIVATE_KEY,
    ALIPAY_PUBLIC_KEY: process.env.ALIPAY_PUBLIC_KEY,
  };
  process.env.PAYMENT_NOTIFY_BASE_URL = "https://pay.example.test";
  process.env.ALIPAY_APP_ID = "2026000000000000";
  process.env.ALIPAY_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
  process.env.ALIPAY_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" });
  try {
    const params = {
      trade_status: "TRADE_SUCCESS",
      total_amount: "100.00",
      out_trade_no: "RTESTORDER",
      trade_no: "20260814000001",
      app_id: process.env.ALIPAY_APP_ID,
      sign_type: "RSA2",
    };
    params.sign = crypto
      .sign("RSA-SHA256", Buffer.from(alipayCanonicalize(params)), privateKey)
      .toString("base64");
    assert.deepEqual(verifyAlipayNotification(params), {
      paid: true,
      orderNo: "RTESTORDER",
      providerTransactionId: "20260814000001",
      amountFen: 10_000,
    });
    assert.throws(
      () => verifyAlipayNotification({ ...params, total_amount: "1.00" }),
      /验签失败/,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("WeChat API v3 resource decryption authenticates ciphertext and AAD", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const nonce = "123456789012";
  const associatedData = "transaction";
  const plaintext = JSON.stringify({ out_trade_no: "RTEST", trade_state: "SUCCESS", amount: { total: 10_000 } });
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const resource = { ciphertext: encrypted, nonce, associated_data: associatedData };
  assert.deepEqual(decryptWechatResource(resource, key), JSON.parse(plaintext));
  assert.throws(
    () => decryptWechatResource({ ...resource, associated_data: "tampered" }, key),
    /解密失败/,
  );
});
