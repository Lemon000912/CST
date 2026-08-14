import crypto from "node:crypto";
import { BillingError, POINT_UNITS, formatPointUnits } from "./billing.js";
import { getSqliteDb, pgPool, withDatabaseTransaction } from "./db.js";
import {
  PaymentProviderError,
  createProviderOrder,
  getPaymentProviderAvailability,
} from "./rechargeProviders.js";

export const RECHARGE_PACKAGE = Object.freeze({
  id: "cny100_points1000",
  amountFen: 10_000,
  amountYuan: 100,
  points: 1_000,
  pointUnits: 1_000 * POINT_UNITS,
});

const PROVIDERS = new Set(["alipay", "wechat"]);
const ORDER_TTL_MS = 15 * 60 * 1000;

function requiredText(value, field, maxLength = 200) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) {
    throw new BillingError("invalid-recharge-request", `${field} is required`, 400);
  }
  return text;
}

function integer(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new BillingError("invalid-recharge-data", `${field} is invalid`, 500);
  return number;
}

function balancePayload(userId, balanceUnits) {
  const units = integer(balanceUnits, "balanceUnits");
  return {
    userId: String(userId),
    balanceUnits: units,
    availableUnits: Math.max(0, units),
    balance: formatPointUnits(units),
  };
}

function publicOrder(row, balance = undefined) {
  if (!row) return null;
  const status = String(row.status);
  return {
    id: String(row.id),
    orderNo: String(row.order_no),
    provider: String(row.provider),
    packageId: String(row.package_id),
    amountFen: integer(row.amount_fen, "amountFen"),
    amountYuan: integer(row.amount_fen, "amountFen") / 100,
    points: integer(row.point_units, "pointUnits") / POINT_UNITS,
    pointUnits: integer(row.point_units, "pointUnits"),
    status,
    codeUrl: status === "creating" || status === "pending" ? row.code_url || null : null,
    failureCode: row.failure_code || null,
    createdAt: integer(row.created_at, "createdAt"),
    updatedAt: integer(row.updated_at, "updatedAt"),
    expiresAt: integer(row.expires_at, "expiresAt"),
    paidAt: row.paid_at == null ? null : integer(row.paid_at, "paidAt"),
    ...(balance ? { billing: balance } : {}),
  };
}

async function readDb() {
  if (pgPool) {
    return {
      dialect: "postgres",
      get: async (sql, params = []) => {
        const result = await pgPool.query(sql, params);
        return result.rows[0] || null;
      },
    };
  }
  return getSqliteDb();
}

async function readOrderById(db, id, lock = false) {
  if (db.dialect === "postgres") {
    return db.get(`SELECT * FROM point_recharge_orders WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  }
  return db.get("SELECT * FROM point_recharge_orders WHERE id = ?", [id]);
}

async function readOrderByNo(db, orderNo, lock = false) {
  if (db.dialect === "postgres") {
    return db.get(`SELECT * FROM point_recharge_orders WHERE order_no = $1${lock ? " FOR UPDATE" : ""}`, [orderNo]);
  }
  return db.get("SELECT * FROM point_recharge_orders WHERE order_no = ?", [orderNo]);
}

async function readOrderByIdempotency(db, userId, idempotencyKey, lock = false) {
  if (db.dialect === "postgres") {
    return db.get(
      `SELECT * FROM point_recharge_orders WHERE user_id = $1 AND idempotency_key = $2${lock ? " FOR UPDATE" : ""}`,
      [userId, idempotencyKey],
    );
  }
  return db.get("SELECT * FROM point_recharge_orders WHERE user_id = ? AND idempotency_key = ?", [userId, idempotencyKey]);
}

function newOrderNo() {
  return `R${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

export function getRechargeCatalog() {
  const availability = getPaymentProviderAvailability();
  return {
    package: RECHARGE_PACKAGE,
    providers: [
      { id: "alipay", label: "支付宝", enabled: availability.alipay },
      { id: "wechat", label: "微信支付", enabled: availability.wechat },
    ],
  };
}

async function markCreateFailed(orderId, error) {
  const failureCode = String(error?.code || "payment-order-create-failed").slice(0, 100);
  const now = Date.now();
  try {
    await withDatabaseTransaction(async (tx) => {
      if (tx.dialect === "postgres") {
        await tx.run(
          "UPDATE point_recharge_orders SET status = 'failed', failure_code = $1, updated_at = $2 WHERE id = $3 AND status = 'creating'",
          [failureCode, now, orderId],
        );
      } else {
        await tx.run(
          "UPDATE point_recharge_orders SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ? AND status = 'creating'",
          [failureCode, now, orderId],
        );
      }
    });
  } catch {
    // Preserve the payment provider error.
  }
}

export async function createRechargeOrder({ userId, provider, idempotencyKey }) {
  const normalizedUserId = requiredText(userId, "userId", 128);
  const normalizedProvider = requiredText(provider, "provider", 32).toLowerCase();
  const normalizedKey = requiredText(idempotencyKey, "idempotencyKey", 200);
  if (!PROVIDERS.has(normalizedProvider)) {
    throw new BillingError("unsupported-payment-provider", "不支持的支付方式", 400);
  }
  const availability = getPaymentProviderAvailability();
  if (!availability[normalizedProvider]) {
    throw new BillingError("payment-provider-not-configured", "该扫码支付方式尚未配置", 503);
  }

  let row;
  let shouldCreateAtProvider = false;
  try {
    const creation = await withDatabaseTransaction(async (tx) => {
      const existing = await readOrderByIdempotency(tx, normalizedUserId, normalizedKey, true);
      if (existing) {
        if (String(existing.provider) !== normalizedProvider || String(existing.package_id) !== RECHARGE_PACKAGE.id) {
          throw new BillingError("idempotency-conflict", "该幂等键已用于其他充值请求", 409);
        }
        return { row: existing, shouldCreateAtProvider: false };
      }
      const id = crypto.randomUUID();
      const orderNo = newOrderNo();
      const now = Date.now();
      const expiresAt = now + ORDER_TTL_MS;
      if (tx.dialect === "postgres") {
        await tx.run(
          `INSERT INTO point_recharge_orders
           (id, order_no, user_id, package_id, provider, idempotency_key, amount_fen, point_units,
            status, created_at, updated_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'creating',$9,$9,$10)`,
          [id, orderNo, normalizedUserId, RECHARGE_PACKAGE.id, normalizedProvider, normalizedKey,
            RECHARGE_PACKAGE.amountFen, RECHARGE_PACKAGE.pointUnits, now, expiresAt],
        );
      } else {
        await tx.run(
          `INSERT INTO point_recharge_orders
           (id, order_no, user_id, package_id, provider, idempotency_key, amount_fen, point_units,
            status, created_at, updated_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,'creating',?,?,?)`,
          [id, orderNo, normalizedUserId, RECHARGE_PACKAGE.id, normalizedProvider, normalizedKey,
            RECHARGE_PACKAGE.amountFen, RECHARGE_PACKAGE.pointUnits, now, now, expiresAt],
        );
      }
      return { row: await readOrderById(tx, id), shouldCreateAtProvider: true };
    });
    row = creation.row;
    shouldCreateAtProvider = creation.shouldCreateAtProvider;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    if (error?.code === "23505" || /UNIQUE constraint failed/i.test(String(error?.message))) {
      const db = await readDb();
      const existing = await readOrderByIdempotency(db, normalizedUserId, normalizedKey);
      if (existing) {
        row = existing;
        shouldCreateAtProvider = false;
      }
      else throw new BillingError("recharge-order-conflict", "充值订单创建冲突，请重试", 409);
    } else {
      throw error;
    }
  }

  // Only the request that inserted the order contacts the provider. A
  // concurrent replay returns the same creating order and cannot race the
  // original request into marking a successfully-created order as failed.
  if (!shouldCreateAtProvider || String(row.status) !== "creating") return publicOrder(row);
  try {
    const providerOrder = await createProviderOrder({
      provider: normalizedProvider,
      orderNo: String(row.order_no),
      amountFen: RECHARGE_PACKAGE.amountFen,
      description: `积分充值：${RECHARGE_PACKAGE.points} 积分`,
    });
    const now = Date.now();
    row = await withDatabaseTransaction(async (tx) => {
      if (tx.dialect === "postgres") {
        await tx.run(
          `UPDATE point_recharge_orders
           SET status = 'pending', code_url = $1, provider_order_id = COALESCE($2, provider_order_id),
               failure_code = NULL, updated_at = $3
           WHERE id = $4 AND status = 'creating'`,
          [providerOrder.codeUrl, providerOrder.providerOrderId, now, row.id],
        );
      } else {
        await tx.run(
          `UPDATE point_recharge_orders
           SET status = 'pending', code_url = ?, provider_order_id = COALESCE(?, provider_order_id),
               failure_code = NULL, updated_at = ?
           WHERE id = ? AND status = 'creating'`,
          [providerOrder.codeUrl, providerOrder.providerOrderId, now, row.id],
        );
      }
      return readOrderById(tx, row.id);
    });
    return publicOrder(row);
  } catch (error) {
    await markCreateFailed(row.id, error);
    if (error instanceof PaymentProviderError) {
      throw new BillingError(error.code, error.message, error.status, error.details);
    }
    throw new BillingError("payment-order-create-failed", "创建扫码支付订单失败", 502);
  }
}

export async function getRechargeOrder({ userId, orderId }) {
  const normalizedUserId = requiredText(userId, "userId", 128);
  const normalizedOrderId = requiredText(orderId, "orderId", 128);
  const db = await readDb();
  const row = await readOrderById(db, normalizedOrderId);
  if (!row || String(row.user_id) !== normalizedUserId) {
    throw new BillingError("recharge-order-not-found", "充值订单不存在", 404);
  }
  let balance;
  if (String(row.status) === "paid") {
    const wallet = db.dialect === "postgres"
      ? await db.get("SELECT balance_units FROM point_wallets WHERE user_id = $1", [normalizedUserId])
      : await db.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [normalizedUserId]);
    if (wallet) balance = balancePayload(normalizedUserId, wallet.balance_units);
  }
  return publicOrder(row, balance);
}

export async function completeRechargeOrder({ provider, orderNo, providerTransactionId, amountFen }) {
  const normalizedProvider = requiredText(provider, "provider", 32).toLowerCase();
  const normalizedOrderNo = requiredText(orderNo, "orderNo", 128);
  const normalizedTransactionId = requiredText(providerTransactionId, "providerTransactionId", 128);
  const normalizedAmountFen = integer(amountFen, "amountFen");
  if (!PROVIDERS.has(normalizedProvider)) throw new BillingError("unsupported-payment-provider", "不支持的支付方式", 400);

  return withDatabaseTransaction(async (tx) => {
    const row = await readOrderByNo(tx, normalizedOrderNo, true);
    if (!row || String(row.provider) !== normalizedProvider) {
      throw new BillingError("recharge-order-not-found", "支付回调对应的充值订单不存在", 404);
    }
    if (integer(row.amount_fen, "amountFen") !== normalizedAmountFen) {
      throw new BillingError("payment-amount-mismatch", "支付金额与充值订单不一致", 400);
    }
    if (String(row.status) === "paid") {
      if (String(row.provider_transaction_id || "") !== normalizedTransactionId) {
        throw new BillingError("payment-transaction-conflict", "支付流水号与已入账订单不一致", 409);
      }
      const wallet = tx.dialect === "postgres"
        ? await tx.get("SELECT balance_units FROM point_wallets WHERE user_id = $1", [row.user_id])
        : await tx.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [row.user_id]);
      return { replayed: true, order: publicOrder(row, wallet ? balancePayload(row.user_id, wallet.balance_units) : undefined) };
    }

    const wallet = tx.dialect === "postgres"
      ? await tx.get("SELECT balance_units FROM point_wallets WHERE user_id = $1 FOR UPDATE", [row.user_id])
      : await tx.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [row.user_id]);
    if (!wallet) throw new BillingError("wallet-not-found", "积分钱包不存在", 404);
    const previousBalanceUnits = integer(wallet.balance_units, "balanceUnits");
    const pointUnits = integer(row.point_units, "pointUnits");
    const nextBalanceUnits = previousBalanceUnits + pointUnits;
    if (!Number.isSafeInteger(nextBalanceUnits)) {
      throw new BillingError("balance-overflow", "积分余额超出安全范围", 500);
    }
    const now = Date.now();
    const metadata = JSON.stringify({
      rechargeOrderId: String(row.id),
      orderNo: normalizedOrderNo,
      provider: normalizedProvider,
      providerTransactionId: normalizedTransactionId,
      amountFen: normalizedAmountFen,
      points: pointUnits / POINT_UNITS,
    });
    if (tx.dialect === "postgres") {
      await tx.run(
        `UPDATE point_recharge_orders
         SET status = 'paid', provider_transaction_id = $1, paid_at = $2, updated_at = $2,
             code_url = NULL, failure_code = NULL
         WHERE id = $3`,
        [normalizedTransactionId, now, row.id],
      );
      await tx.run("UPDATE point_wallets SET balance_units = $1, updated_at = $2 WHERE user_id = $3", [nextBalanceUnits, now, row.user_id]);
      await tx.run(
        `INSERT INTO point_ledger
         (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
         VALUES ($1,$2,NULL,'recharge',$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), row.user_id, `recharge:${row.id}`, pointUnits, nextBalanceUnits, metadata, now],
      );
    } else {
      await tx.run(
        `UPDATE point_recharge_orders
         SET status = 'paid', provider_transaction_id = ?, paid_at = ?, updated_at = ?,
             code_url = NULL, failure_code = NULL
         WHERE id = ?`,
        [normalizedTransactionId, now, now, row.id],
      );
      await tx.run("UPDATE point_wallets SET balance_units = ?, updated_at = ? WHERE user_id = ?", [nextBalanceUnits, now, row.user_id]);
      await tx.run(
        `INSERT INTO point_ledger
         (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
         VALUES (?,?,NULL,'recharge',?,?,?,?,?)`,
        [crypto.randomUUID(), row.user_id, `recharge:${row.id}`, pointUnits, nextBalanceUnits, metadata, now],
      );
    }
    const completedRow = await readOrderById(tx, row.id);
    return { replayed: false, order: publicOrder(completedRow, balancePayload(row.user_id, nextBalanceUnits)) };
  });
}
