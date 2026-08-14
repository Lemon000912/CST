import crypto from "node:crypto";
import { pgPool, getSqliteDb, withDatabaseTransaction } from "./db.js";

export const POINT_UNITS = 20;
export const SIGNUP_GRANT_UNITS = 20_000;
export const PRICE_UNITS = Object.freeze({
  character: 1,
  chartPoint: 2,
  pdf: 20,
});
export const PRICING_CATALOG = Object.freeze({
  unitsPerPoint: POINT_UNITS,
  signupGrantUnits: SIGNUP_GRANT_UNITS,
  characterUnits: PRICE_UNITS.character,
  chartPointUnits: PRICE_UNITS.chartPoint,
  pdfUnits: PRICE_UNITS.pdf,
});

const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const OPERATION_TYPES = new Set(["search", "chart", "pdf", "deep_search", "deep_pdf"]);

export class BillingError extends Error {
  constructor(code, message, status = 500, details = undefined) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class BillingUnavailableError extends BillingError {
  constructor(message = "Billing service is unavailable", cause = undefined) {
    super("billing-unavailable", message, 503);
    this.name = "BillingUnavailableError";
    this.cause = cause;
  }
}

function assertNonEmpty(value, field, maxLength = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new BillingError("invalid-billing-request", `${field} is required`, 400);
  }
  return normalized;
}

function normalizeOperationType(value) {
  const operationType = assertNonEmpty(value, "operationType", 64);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(operationType)) {
    throw new BillingError("invalid-operation-type", "Invalid billing operation type", 400);
  }
  // Known types document the initial catalog, while allowing route-specific
  // extensions without a schema migration.
  return OPERATION_TYPES.has(operationType) ? operationType : operationType;
}

function canonicalize(value, seen = new Set()) {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Request contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "undefined") return { $undefined: true };
  if (typeof value !== "object") throw new TypeError(`Unsupported request value: ${typeof value}`);
  if (seen.has(value)) throw new TypeError("Request contains a circular reference");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    if (value instanceof Date) return { $date: value.toISOString() };
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { $bytes: Buffer.from(value).toString("base64") };
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function stableRequestHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function countUnicodeCodePoints(value) {
  return Array.from(String(value ?? "")).length;
}

export function formatPointUnits(units) {
  const value = Number(units);
  if (!Number.isSafeInteger(value)) throw new TypeError("Point units must be a safe integer");
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / POINT_UNITS)}.${String((absolute % POINT_UNITS) * 5).padStart(2, "0")}`;
}

export function calculateCostUnits({ characterCount = 0, chartPointCount = 0, pdfCount = 0 } = {}) {
  const values = [characterCount, chartPointCount, pdfCount];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Billing quantities must be non-negative safe integers");
  }
  const total =
    characterCount * PRICE_UNITS.character +
    chartPointCount * PRICE_UNITS.chartPoint +
    pdfCount * PRICE_UNITS.pdf;
  if (!Number.isSafeInteger(total)) throw new TypeError("Calculated cost exceeds safe integer range");
  return total;
}

function parseJson(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new BillingUnavailableError("Stored billing data is invalid");
  }
}

function normalizeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new BillingUnavailableError(`Stored ${field} is outside the safe integer range`);
  }
  return number;
}

function publicOperation(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    operationType: String(row.operation_type),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    status: String(row.status),
    costUnits: row.cost_units === null || row.cost_units === undefined
      ? null
      : normalizeInteger(row.cost_units, "operation cost"),
    billingDetails: parseJson(row.billing_details_json),
    result: parseJson(row.result_json),
    receipt: parseJson(row.receipt_json),
    errorCode: row.error_code || null,
    leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined
      ? null
      : normalizeInteger(row.lease_expires_at, "lease expiration"),
    leaseToken: row.lease_token || null,
    createdAt: normalizeInteger(row.created_at, "creation time"),
    updatedAt: normalizeInteger(row.updated_at, "update time"),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? null
      : normalizeInteger(row.completed_at, "completion time"),
  };
}

function balancePayload(userId, units) {
  const balanceUnits = normalizeInteger(units, "wallet balance");
  return {
    userId: String(userId),
    balanceUnits,
    availableUnits: Math.max(0, balanceUnits),
    balance: formatPointUnits(balanceUnits),
  };
}

async function readWallet(db, userId, lock = false) {
  if (db.dialect === "postgres") {
    return db.get(
      `SELECT user_id, balance_units FROM point_wallets WHERE user_id = $1${lock ? " FOR UPDATE" : ""}`,
      [userId],
    );
  }
  return db.get(`SELECT user_id, balance_units FROM point_wallets WHERE user_id = ?`, [userId]);
}

async function readOperationByKey(db, userId, operationType, idempotencyKey, lock = false) {
  if (db.dialect === "postgres") {
    return db.get(
      `SELECT * FROM point_operations
       WHERE user_id = $1 AND operation_type = $2 AND idempotency_key = $3${lock ? " FOR UPDATE" : ""}`,
      [userId, operationType, idempotencyKey],
    );
  }
  return db.get(
    `SELECT * FROM point_operations WHERE user_id = ? AND operation_type = ? AND idempotency_key = ?`,
    [userId, operationType, idempotencyKey],
  );
}

async function readOperationById(db, operationId, lock = false) {
  if (db.dialect === "postgres") {
    return db.get(`SELECT * FROM point_operations WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [operationId]);
  }
  return db.get(`SELECT * FROM point_operations WHERE id = ?`, [operationId]);
}

async function getReadDb() {
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

export async function getPointBalance(userId) {
  const normalizedUserId = assertNonEmpty(userId, "userId", 128);
  try {
    const db = await getReadDb();
    const wallet = await readWallet(db, normalizedUserId);
    if (!wallet) throw new BillingError("wallet-not-found", "Point wallet was not found", 404);
    return balancePayload(normalizedUserId, wallet.balance_units);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingUnavailableError(undefined, error);
  }
}

export async function getBillableOperation({ operationId, userId }) {
  const normalizedOperationId = assertNonEmpty(operationId, "operationId", 128);
  const normalizedUserId = assertNonEmpty(userId, "userId", 128);
  try {
    const db = await getReadDb();
    const row = await readOperationById(db, normalizedOperationId);
    if (!row || String(row.user_id) !== normalizedUserId) {
      throw new BillingError("operation-not-found", "Billing operation was not found", 404);
    }
    return publicOperation(row);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingUnavailableError(undefined, error);
  }
}

export const getOperation = getBillableOperation;

function replayOrConflict(existing, requestHash) {
  if (String(existing.request_hash) !== requestHash) {
    throw new BillingError(
      "idempotency-conflict",
      "Idempotency key was already used for a different request",
      409,
      { operationId: String(existing.id) },
    );
  }
  if (existing.status === "completed") {
    return { replayed: true, operation: publicOperation(existing) };
  }
  if (existing.status === "processing") {
    throw new BillingError(
      "operation-in-progress",
      "This billing operation is still processing",
      202,
      { operationId: String(existing.id) },
    );
  }
  return null;
}

export async function beginBillableOperation({
  userId,
  operationType,
  idempotencyKey,
  requestHash,
  request,
  leaseMs = DEFAULT_LEASE_MS,
}) {
  const normalizedUserId = assertNonEmpty(userId, "userId", 128);
  const normalizedType = normalizeOperationType(operationType);
  const normalizedKey = assertNonEmpty(idempotencyKey, "idempotencyKey", 200);
  const normalizedHash = requestHash
    ? assertNonEmpty(requestHash, "requestHash", 128)
    : stableRequestHash(request);
  if (!/^[a-f0-9]{64}$/i.test(normalizedHash)) {
    throw new BillingError("invalid-request-hash", "requestHash must be a SHA-256 hex digest", 400);
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new BillingError("invalid-lease", "leaseMs must be a positive safe integer", 400);
  }

  try {
    return await withDatabaseTransaction(async (tx) => {
      let existing = await readOperationByKey(tx, normalizedUserId, normalizedType, normalizedKey, true);
      if (existing && String(existing.request_hash) !== normalizedHash) {
        replayOrConflict(existing, normalizedHash);
      }
      if (existing?.status === "completed") {
        return { replayed: true, operation: publicOperation(existing) };
      }

      const now = Date.now();
      const leaseExpiresAt = now + leaseMs;
      const leaseToken = crypto.randomUUID();
      if (existing?.status === "processing") {
        const existingLease = Number(existing.lease_expires_at) || 0;
        if (existingLease > now) replayOrConflict(existing, normalizedHash);
        if (tx.dialect === "postgres") {
          await tx.run(
            `UPDATE point_operations SET lease_expires_at = $1, lease_token = $2, updated_at = $3 WHERE id = $4`,
            [leaseExpiresAt, leaseToken, now, existing.id],
          );
        } else {
          await tx.run(
            `UPDATE point_operations SET lease_expires_at = ?, lease_token = ?, updated_at = ? WHERE id = ?`,
            [leaseExpiresAt, leaseToken, now, existing.id],
          );
        }
        existing = await readOperationById(tx, existing.id);
        return { replayed: false, resumed: true, operation: publicOperation(existing) };
      }

      let active = tx.dialect === "postgres"
        ? await tx.get(`SELECT * FROM point_operations WHERE user_id = $1 AND status = 'processing' FOR UPDATE`, [normalizedUserId])
        : await tx.get(`SELECT * FROM point_operations WHERE user_id = ? AND status = 'processing'`, [normalizedUserId]);
      if (active && (Number(active.lease_expires_at) || 0) <= now) {
        if (tx.dialect === "postgres") {
          await tx.run(
            `UPDATE point_operations SET status = 'failed', error_code = 'lease-expired',
             lease_expires_at = NULL, lease_token = NULL, updated_at = $1, completed_at = $1 WHERE id = $2`,
            [now, active.id],
          );
        } else {
          await tx.run(
            `UPDATE point_operations SET status = 'failed', error_code = 'lease-expired',
             lease_expires_at = NULL, lease_token = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
            [now, now, active.id],
          );
        }
        active = null;
      }
      if (active) {
        throw new BillingError(
          "operation-in-progress",
          "Another billing operation is still processing",
          202,
          { operationId: String(active.id) },
        );
      }

      const wallet = await readWallet(tx, normalizedUserId, true);
      if (!wallet) throw new BillingError("wallet-not-found", "Point wallet was not found", 404);
      const balanceUnits = normalizeInteger(wallet.balance_units, "wallet balance");
      if (balanceUnits <= 0) {
        throw new BillingError("insufficient-points", "Point balance must be positive to begin an operation", 402, {
          balanceUnits,
          balance: formatPointUnits(balanceUnits),
        });
      }

      if (existing?.status === "failed") {
        if (tx.dialect === "postgres") {
          await tx.run(
            `UPDATE point_operations SET status = 'processing', error_code = NULL,
             lease_expires_at = $1, lease_token = $2, updated_at = $3, completed_at = NULL
             WHERE id = $4`,
            [leaseExpiresAt, leaseToken, now, existing.id],
          );
        } else {
          await tx.run(
            `UPDATE point_operations SET status = 'processing', error_code = NULL,
             lease_expires_at = ?, lease_token = ?, updated_at = ?, completed_at = NULL WHERE id = ?`,
            [leaseExpiresAt, leaseToken, now, existing.id],
          );
        }
        existing = await readOperationById(tx, existing.id);
        return { replayed: false, resumed: true, operation: publicOperation(existing) };
      }

      const operationId = crypto.randomUUID();
      if (tx.dialect === "postgres") {
        await tx.run(
          `INSERT INTO point_operations
           (id, user_id, operation_type, idempotency_key, request_hash, status, lease_expires_at, lease_token, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,'processing',$6,$7,$8,$8)`,
          [operationId, normalizedUserId, normalizedType, normalizedKey, normalizedHash, leaseExpiresAt, leaseToken, now],
        );
      } else {
        await tx.run(
          `INSERT INTO point_operations
           (id, user_id, operation_type, idempotency_key, request_hash, status, lease_expires_at, lease_token, created_at, updated_at)
           VALUES (?,?,?,?,?,'processing',?,?,?,?)`,
          [operationId, normalizedUserId, normalizedType, normalizedKey, normalizedHash, leaseExpiresAt, leaseToken, now, now],
        );
      }
      return {
        replayed: false,
        operation: publicOperation(await readOperationById(tx, operationId)),
        balance: balancePayload(normalizedUserId, balanceUnits),
      };
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    if (error?.code === "23505" || /UNIQUE constraint failed/i.test(String(error?.message))) {
      throw new BillingError("operation-in-progress", "Another billing operation is still processing", 202);
    }
    throw new BillingUnavailableError(undefined, error);
  }
}

export async function completeBillableOperation({
  operationId,
  userId,
  leaseToken,
  costUnits,
  billingDetails = {},
  result,
  receipt = {},
}) {
  const normalizedOperationId = assertNonEmpty(operationId, "operationId", 128);
  const normalizedUserId = assertNonEmpty(userId, "userId", 128);
  const normalizedLeaseToken = assertNonEmpty(leaseToken, "leaseToken", 128);
  if (!Number.isSafeInteger(costUnits) || costUnits < 0) {
    throw new BillingError("invalid-cost", "costUnits must be a non-negative safe integer", 400);
  }

  let resultJson;
  let detailsJson;
  try {
    resultJson = JSON.stringify(result ?? null);
    detailsJson = JSON.stringify(billingDetails ?? {});
    if (resultJson === undefined || detailsJson === undefined) throw new TypeError("Value is not serializable");
  } catch (error) {
    throw new BillingError("result-not-serializable", "Billing result could not be serialized", 500, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    return await withDatabaseTransaction(async (tx) => {
      const operation = await readOperationById(tx, normalizedOperationId, true);
      if (!operation || String(operation.user_id) !== normalizedUserId) {
        throw new BillingError("operation-not-found", "Billing operation was not found", 404);
      }
      if (operation.status === "completed") {
        const completed = publicOperation(operation);
        return { replayed: true, operation: completed, receipt: completed.receipt };
      }
      if (operation.status !== "processing") {
        throw new BillingError("operation-not-processing", "Billing operation is not processing", 409);
      }
      if (String(operation.lease_token || "") !== normalizedLeaseToken) {
        throw new BillingError("lease-conflict", "Billing operation lease is no longer owned by this worker", 409);
      }
      if ((Number(operation.lease_expires_at) || 0) <= Date.now()) {
        throw new BillingError("lease-expired", "Billing operation lease has expired", 409);
      }

      const wallet = await readWallet(tx, normalizedUserId, true);
      if (!wallet) throw new BillingError("wallet-not-found", "Point wallet was not found", 404);
      const previousBalanceUnits = normalizeInteger(wallet.balance_units, "wallet balance");
      if (costUnits > previousBalanceUnits) {
        throw new BillingError(
          "insufficient-points",
          "Point balance is insufficient to complete this operation",
          402,
          {
            requiredUnits: costUnits,
            balanceUnits: previousBalanceUnits,
            balance: formatPointUnits(previousBalanceUnits),
          },
        );
      }
      const balanceUnits = previousBalanceUnits - costUnits;
      if (!Number.isSafeInteger(balanceUnits)) {
        throw new BillingError("balance-overflow", "Point balance exceeds safe integer range", 500);
      }
      const now = Date.now();
      const finalReceipt = {
        ...receipt,
        operationId: normalizedOperationId,
        costUnits,
        cost: formatPointUnits(costUnits),
        previousBalanceUnits,
        balanceUnits,
        balance: formatPointUnits(balanceUnits),
        billingDetails,
      };
      let receiptJson;
      try {
        receiptJson = JSON.stringify(finalReceipt);
      } catch {
        throw new BillingError("result-not-serializable", "Billing receipt could not be serialized", 500);
      }

      if (tx.dialect === "postgres") {
        await tx.run(
          `UPDATE point_wallets SET balance_units = $1, updated_at = $2 WHERE user_id = $3`,
          [balanceUnits, now, normalizedUserId],
        );
        await tx.run(
          `INSERT INTO point_ledger
           (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
           VALUES ($1,$2,$3,'debit',$4,$5,$6,$7,$8)`,
          [crypto.randomUUID(), normalizedUserId, normalizedOperationId, `operation:${normalizedOperationId}`, -costUnits, balanceUnits, detailsJson, now],
        );
        await tx.run(
          `UPDATE point_operations SET status = 'completed', cost_units = $1,
           billing_details_json = $2, result_json = $3, receipt_json = $4,
           error_code = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = $5, completed_at = $5
           WHERE id = $6`,
          [costUnits, detailsJson, resultJson, receiptJson, now, normalizedOperationId],
        );
      } else {
        await tx.run(
          `UPDATE point_wallets SET balance_units = ?, updated_at = ? WHERE user_id = ?`,
          [balanceUnits, now, normalizedUserId],
        );
        await tx.run(
          `INSERT INTO point_ledger
           (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
           VALUES (?,?,?,'debit',?,?,?,?,?)`,
          [crypto.randomUUID(), normalizedUserId, normalizedOperationId, `operation:${normalizedOperationId}`, -costUnits, balanceUnits, detailsJson, now],
        );
        await tx.run(
          `UPDATE point_operations SET status = 'completed', cost_units = ?,
           billing_details_json = ?, result_json = ?, receipt_json = ?,
           error_code = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = ?, completed_at = ?
           WHERE id = ?`,
          [costUnits, detailsJson, resultJson, receiptJson, now, now, normalizedOperationId],
        );
      }
      return {
        replayed: false,
        operation: publicOperation(await readOperationById(tx, normalizedOperationId)),
        receipt: finalReceipt,
      };
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    if (error?.code === "23505" || /UNIQUE constraint failed/i.test(String(error?.message))) {
      // An existing ledger row means another completion won; read and replay it.
      const operation = await getBillableOperation({ operationId: normalizedOperationId, userId: normalizedUserId });
      if (operation.status === "completed") return { replayed: true, operation, receipt: operation.receipt };
    }
    throw new BillingUnavailableError(undefined, error);
  }
}

export async function failBillableOperation({ operationId, userId, leaseToken, errorCode = "operation-failed" }) {
  const normalizedOperationId = assertNonEmpty(operationId, "operationId", 128);
  const normalizedUserId = assertNonEmpty(userId, "userId", 128);
  const normalizedLeaseToken = assertNonEmpty(leaseToken, "leaseToken", 128);
  const normalizedErrorCode = assertNonEmpty(errorCode, "errorCode", 100);
  try {
    return await withDatabaseTransaction(async (tx) => {
      const operation = await readOperationById(tx, normalizedOperationId, true);
      if (!operation || String(operation.user_id) !== normalizedUserId) {
        throw new BillingError("operation-not-found", "Billing operation was not found", 404);
      }
      if (operation.status === "completed" || operation.status === "failed") {
        return { replayed: true, operation: publicOperation(operation) };
      }
      if (String(operation.lease_token || "") !== normalizedLeaseToken) {
        throw new BillingError("lease-conflict", "Billing operation lease is no longer owned by this worker", 409);
      }
      const now = Date.now();
      if ((Number(operation.lease_expires_at) || 0) <= now) {
        throw new BillingError("lease-expired", "Billing operation lease has expired", 409);
      }
      if (tx.dialect === "postgres") {
        await tx.run(
          `UPDATE point_operations SET status = 'failed', error_code = $1,
           lease_expires_at = NULL, lease_token = NULL, updated_at = $2, completed_at = $2 WHERE id = $3`,
          [normalizedErrorCode, now, normalizedOperationId],
        );
      } else {
        await tx.run(
          `UPDATE point_operations SET status = 'failed', error_code = ?,
           lease_expires_at = NULL, lease_token = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
          [normalizedErrorCode, now, now, normalizedOperationId],
        );
      }
      return { replayed: false, operation: publicOperation(await readOperationById(tx, normalizedOperationId)) };
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingUnavailableError(undefined, error);
  }
}
