import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-recharge-${process.pid}-${crypto.randomUUID()}.sqlite`);
const pemDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cst-wechat-pay-pem-"));
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPath = path.join(pemDirectory, "apiclient_key.pem");
const publicKeyPath = path.join(pemDirectory, "pub_key.pem");
fs.writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";
process.env.WECHAT_PAY_APP_ID = "wx-test-app";
process.env.WECHAT_PAY_MCH_ID = "1900000001";
process.env.WECHAT_PAY_MCH_SERIAL_NO = "MERCHANT-SERIAL-TEST";
process.env.WECHAT_PAY_API_V3_KEY = "0123456789abcdef0123456789abcdef";
process.env.WECHAT_PAY_PRIVATE_KEY_PATH = privateKeyPath;
process.env.WECHAT_PAY_PUBLIC_KEY_PATH = publicKeyPath;
process.env.WECHAT_PAY_PUBLIC_KEY_ID = "PUB_KEY_ID_3000000001";
process.env.WECHAT_PAY_NOTIFY_URL = "https://example.test/api/pay/wechat/notify";

const { createUserRecord, getSqliteDb, initDatabase, withDatabaseTransaction } = await import("../db.js");
const {
  completeRechargeOrder,
  createRechargeOrder,
  getRechargeOrderByNo,
  newOrderNo,
  RECHARGE_PACKAGE,
} = await import("../recharge.js");

test.after(() => {
  try {
    fs.rmSync(sqliteFile, { force: true });
  } catch {
    // The sql.js process lock is released when this test worker exits.
  }
  fs.rmSync(pemDirectory, { recursive: true, force: true });
});

test("paid recharge credits wallet and ledger exactly once", async () => {
  await initDatabase();
  const userId = "recharge-test-user";
  await createUserRecord(userId, "recharge_test_user", "not-used-in-this-test");
  const orderId = crypto.randomUUID();
  const orderNo = "RINTEGRATIONTEST0001";
  const now = Date.now();
  await withDatabaseTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO point_recharge_orders
       (id, order_no, user_id, package_id, provider, idempotency_key, amount_fen, point_units,
        status, created_at, updated_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      [orderId, orderNo, userId, RECHARGE_PACKAGE.id, "alipay", "integration-order-1",
        RECHARGE_PACKAGE.amountFen, RECHARGE_PACKAGE.pointUnits, now, now, now + 900_000],
    );
  });

  const first = await completeRechargeOrder({
    provider: "alipay",
    orderNo,
    providerTransactionId: "ALIPAY-INTEGRATION-TRANSACTION-1",
    amountFen: RECHARGE_PACKAGE.amountFen,
  });
  assert.equal(first.replayed, false);
  assert.equal(first.order.status, "paid");
  assert.equal(first.order.billing.balanceUnits, 40_000);

  const replay = await completeRechargeOrder({
    provider: "alipay",
    orderNo,
    providerTransactionId: "ALIPAY-INTEGRATION-TRANSACTION-1",
    amountFen: RECHARGE_PACKAGE.amountFen,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.billing.balanceUnits, 40_000);

  const db = await getSqliteDb();
  const wallet = await db.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [userId]);
  const ledger = await db.all("SELECT * FROM point_ledger WHERE user_id = ? AND entry_type = 'recharge'", [userId]);
  assert.equal(Number(wallet.balance_units), 40_000);
  assert.equal(ledger.length, 1);
  assert.equal(Number(ledger[0].delta_units), RECHARGE_PACKAGE.pointUnits);
  assert.equal(ledger[0].idempotency_key, `recharge:${orderId}`);
});

test("WeChat order amount comes from the server plan and its number matches the API-v3 format", async () => {
  await initDatabase();
  const userId = "wechat-create-user";
  await createUserRecord(userId, "wechat_create_user", "not-used-in-this-test");
  let providerRequest;
  const order = await createRechargeOrder({
    userId,
    provider: "wechat",
    planId: RECHARGE_PACKAGE.id,
    idempotencyKey: "wechat-create-1",
    amountFen: 1,
    createProviderOrderImpl: async (request) => {
      providerRequest = request;
      return { codeUrl: "weixin://wxpay/bizpayurl?pr=test" };
    },
  });
  assert.match(order.orderNo, /^WX\d{14}[A-F0-9]{8}$/);
  assert.equal(order.orderNo.length, 24);
  assert.match(newOrderNo("wechat"), /^WX\d{14}[A-F0-9]{8}$/);
  assert.equal(providerRequest.amountFen, RECHARGE_PACKAGE.amountFen);
  assert.equal(order.amountFen, RECHARGE_PACKAGE.amountFen);
  assert.equal(order.status, "pending");
});

test("a user cannot query another user's WeChat payment order", async () => {
  await assert.rejects(
    getRechargeOrderByNo({ userId: "some-other-user", orderNo: "WX-NOT-OWNED" }),
    (error) => error?.code === "recharge-order-not-found" && error?.status === 404,
  );
});

test("wrong callback amount cannot mark a WeChat order paid", async () => {
  await initDatabase();
  const userId = "wechat-amount-user";
  await createUserRecord(userId, "wechat_amount_user", "not-used-in-this-test");
  const order = await createRechargeOrder({
    userId,
    provider: "wechat",
    planId: RECHARGE_PACKAGE.id,
    idempotencyKey: "wechat-wrong-amount",
    createProviderOrderImpl: async () => ({ codeUrl: "weixin://wxpay/bizpayurl?pr=amount" }),
  });
  await assert.rejects(
    completeRechargeOrder({
      provider: "wechat",
      orderNo: order.orderNo,
      providerTransactionId: "WX-TRANSACTION-WRONG-AMOUNT",
      amountFen: 1,
    }),
    (error) => error?.code === "payment-amount-mismatch",
  );
  const unchanged = await getRechargeOrderByNo({ userId, orderNo: order.orderNo });
  assert.equal(unchanged.status, "pending");
});

test("repeated WeChat success notification credits points exactly once", async () => {
  await initDatabase();
  const userId = "wechat-idempotent-user";
  await createUserRecord(userId, "wechat_idempotent_user", "not-used-in-this-test");
  const order = await createRechargeOrder({
    userId,
    provider: "wechat",
    planId: RECHARGE_PACKAGE.id,
    idempotencyKey: "wechat-idempotent",
    createProviderOrderImpl: async () => ({ codeUrl: "weixin://wxpay/bizpayurl?pr=idempotent" }),
  });
  const payment = {
    provider: "wechat",
    orderNo: order.orderNo,
    providerTransactionId: "WX-TRANSACTION-IDEMPOTENT",
    amountFen: RECHARGE_PACKAGE.amountFen,
  };
  const first = await completeRechargeOrder(payment);
  const replay = await completeRechargeOrder(payment);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.order.status, "paid");
  assert.equal(replay.order.status, "paid");
  const db = await getSqliteDb();
  const ledger = await db.all("SELECT * FROM point_ledger WHERE user_id = ? AND entry_type = 'recharge'", [userId]);
  assert.equal(ledger.length, 1);
});

test("production ignores the one-fen WeChat test override", async () => {
  await initDatabase();
  const userId = "wechat-production-amount-user";
  await createUserRecord(userId, "wechat_production_amount_user", "not-used-in-this-test");
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  process.env.WECHAT_PAY_TEST_MODE = "true";
  process.env.WECHAT_PAY_TEST_AMOUNT_FEN = "1";
  let charged;
  try {
    await createRechargeOrder({
      userId,
      provider: "wechat",
      planId: RECHARGE_PACKAGE.id,
      idempotencyKey: "wechat-production-amount",
      createProviderOrderImpl: async ({ amountFen }) => {
        charged = amountFen;
        return { codeUrl: "weixin://wxpay/bizpayurl?pr=production" };
      },
    });
  } finally {
    process.env.NODE_ENV = savedNodeEnv;
    delete process.env.WECHAT_PAY_TEST_MODE;
    delete process.env.WECHAT_PAY_TEST_AMOUNT_FEN;
  }
  assert.equal(charged, RECHARGE_PACKAGE.amountFen);
});

test("expired Native order closes locally and cannot grant points", async () => {
  await initDatabase();
  const userId = "wechat-expired-user";
  await createUserRecord(userId, "wechat_expired_user", "not-used-in-this-test");
  const order = await createRechargeOrder({
    userId,
    provider: "wechat",
    planId: RECHARGE_PACKAGE.id,
    idempotencyKey: "wechat-expired",
    createProviderOrderImpl: async () => ({ codeUrl: "weixin://wxpay/bizpayurl?pr=expired" }),
  });
  await withDatabaseTransaction(async (tx) => {
    await tx.run("UPDATE point_recharge_orders SET expires_at = ? WHERE id = ?", [Date.now() - 1, order.id]);
  });
  const closed = await getRechargeOrderByNo({ userId, orderNo: order.orderNo });
  assert.equal(closed.status, "closed");
  assert.equal(closed.codeUrl, null);
  await assert.rejects(
    completeRechargeOrder({
      provider: "wechat",
      orderNo: order.orderNo,
      providerTransactionId: "WX-TRANSACTION-EXPIRED",
      amountFen: RECHARGE_PACKAGE.amountFen,
    }),
    (error) => error?.code === "payment-order-state-invalid",
  );
});
