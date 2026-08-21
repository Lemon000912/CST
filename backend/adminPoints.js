import crypto from "node:crypto";
import { formatPointUnits, POINT_UNITS } from "./billing.js";
import { getSqliteDb, pgPool, withDatabaseTransaction } from "./db.js";

const LOW_BALANCE_UNITS = 100 * POINT_UNITS;
const MAX_ADJUSTMENT_POINTS = 10_000_000;

export class AdminPointsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AdminPointsError";
    this.status = status;
    this.code = code;
  }
}

function safeInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AdminPointsError(500, "invalid-points-data", `${field} 超出安全范围`);
  }
  return parsed;
}

export function parseAdminPointAmount(value, { allowZero = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(raw)) {
    throw new AdminPointsError(400, "invalid-point-amount", "积分必须是有效数字，最多保留两位小数");
  }
  const [wholeText, decimalText = ""] = raw.split(".");
  const cents = Number(wholeText) * 100 + Number(decimalText.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents % 5 !== 0) {
    throw new AdminPointsError(400, "invalid-point-precision", "积分调整必须以 0.05 为最小单位");
  }
  const units = cents / 5;
  if ((!allowZero && units <= 0) || (allowZero && units < 0)) {
    throw new AdminPointsError(400, "invalid-point-amount", allowZero ? "积分不能为负数" : "积分必须大于 0");
  }
  if (units > MAX_ADJUSTMENT_POINTS * POINT_UNITS) {
    throw new AdminPointsError(400, "point-amount-too-large", `单次调整不能超过 ${MAX_ADJUSTMENT_POINTS.toLocaleString("zh-CN")} 积分`);
  }
  return units;
}

function publicLedgerEntry(row) {
  const deltaUnits = safeInteger(row.delta_units, "积分变动");
  const balanceAfterUnits = safeInteger(row.balance_after_units, "变动后余额");
  let metadata = null;
  try {
    metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
  } catch {
    metadata = null;
  }
  return {
    id: String(row.id),
    userId: String(row.user_id),
    username: row.username ? String(row.username) : "-",
    entryType: String(row.entry_type),
    deltaUnits,
    delta: formatPointUnits(deltaUnits),
    balanceAfterUnits,
    balanceAfter: formatPointUnits(balanceAfterUnits),
    reason: metadata?.reason || metadata?.description || "系统积分变动",
    operator: metadata?.adminUsername || (row.entry_type === "recharge" ? "支付系统" : "系统"),
    adjustmentMode: metadata?.mode || null,
    createdAt: safeInteger(row.created_at, "流水时间"),
  };
}

async function getReadDb() {
  if (pgPool) {
    return {
      dialect: "postgres",
      get: async (sql, params = []) => {
        const result = await pgPool.query(sql, params);
        return result.rows[0] || null;
      },
      all: async (sql, params = []) => {
        const result = await pgPool.query(sql, params);
        return result.rows;
      },
    };
  }
  return getSqliteDb();
}

function balanceStatusSql(status) {
  if (status === "empty") return "COALESCE(w.balance_units, 0) <= 0";
  if (status === "low") return `COALESCE(w.balance_units, 0) > 0 AND COALESCE(w.balance_units, 0) <= ${LOW_BALANCE_UNITS}`;
  if (status === "healthy") return `COALESCE(w.balance_units, 0) > ${LOW_BALANCE_UNITS}`;
  return "1 = 1";
}

export async function listAdminPointUsers({ skip = 0, limit = 10, search = "", status = "" } = {}) {
  const normalizedSkip = Math.max(0, Number(skip) || 0);
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 10));
  const normalizedSearch = String(search || "").trim().slice(0, 100);
  const normalizedStatus = ["empty", "low", "healthy"].includes(status) ? status : "";
  const db = await getReadDb();
  const clauses = [balanceStatusSql(normalizedStatus)];
  const countParams = [];

  if (normalizedSearch) {
    if (db.dialect === "postgres") {
      countParams.push(`%${normalizedSearch}%`);
      clauses.push(`(u.username ILIKE $${countParams.length} OR u.id::text ILIKE $${countParams.length})`);
    } else {
      countParams.push(`%${normalizedSearch.toLowerCase()}%`, `%${normalizedSearch.toLowerCase()}%`);
      clauses.push("(LOWER(u.username) LIKE ? OR LOWER(CAST(u.id AS TEXT)) LIKE ?)");
    }
  }

  const whereSql = clauses.join(" AND ");
  const countRow = await db.get(
    `SELECT COUNT(*) AS total
     FROM users u LEFT JOIN point_wallets w ON w.user_id = u.id
     WHERE ${whereSql}`,
    countParams,
  );

  let rows;
  const baseSql = `
    SELECT u.id, u.username, u.created_at,
           COALESCE(w.balance_units, 0) AS balance_units,
           COALESCE(ls.credited_units, 0) AS credited_units,
           COALESCE(ls.debited_units, 0) AS debited_units,
           ls.last_changed_at
    FROM users u
    LEFT JOIN point_wallets w ON w.user_id = u.id
    LEFT JOIN (
      SELECT user_id,
             SUM(CASE WHEN delta_units > 0 THEN delta_units ELSE 0 END) AS credited_units,
             SUM(CASE WHEN delta_units < 0 THEN -delta_units ELSE 0 END) AS debited_units,
             MAX(created_at) AS last_changed_at
      FROM point_ledger GROUP BY user_id
    ) ls ON ls.user_id = u.id
    WHERE ${whereSql}
    ORDER BY COALESCE(ls.last_changed_at, u.created_at) DESC`;

  if (db.dialect === "postgres") {
    const params = [...countParams, normalizedLimit, normalizedSkip];
    rows = await db.all(`${baseSql} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  } else {
    rows = await db.all(`${baseSql} LIMIT ? OFFSET ?`, [...countParams, normalizedLimit, normalizedSkip]);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const summary = await db.get(
    db.dialect === "postgres"
      ? `SELECT
           COUNT(*) AS wallet_count,
           COALESCE(SUM(balance_units), 0) AS total_balance_units,
           COUNT(*) FILTER (WHERE balance_units <= ${LOW_BALANCE_UNITS}) AS attention_count,
           COALESCE((SELECT SUM(CASE WHEN delta_units > 0 THEN delta_units ELSE 0 END) FROM point_ledger WHERE created_at >= $1), 0) AS today_credited_units,
           COALESCE((SELECT SUM(CASE WHEN delta_units < 0 THEN -delta_units ELSE 0 END) FROM point_ledger WHERE created_at >= $1), 0) AS today_debited_units
         FROM point_wallets`
      : `SELECT
           COUNT(*) AS wallet_count,
           COALESCE(SUM(balance_units), 0) AS total_balance_units,
           SUM(CASE WHEN balance_units <= ${LOW_BALANCE_UNITS} THEN 1 ELSE 0 END) AS attention_count,
           COALESCE((SELECT SUM(CASE WHEN delta_units > 0 THEN delta_units ELSE 0 END) FROM point_ledger WHERE created_at >= ?), 0) AS today_credited_units,
           COALESCE((SELECT SUM(CASE WHEN delta_units < 0 THEN -delta_units ELSE 0 END) FROM point_ledger WHERE created_at >= ?), 0) AS today_debited_units
         FROM point_wallets`,
    db.dialect === "postgres" ? [todayStart] : [todayStart, todayStart],
  );

  return {
    users: rows.map((row) => {
      const balanceUnits = safeInteger(row.balance_units, "积分余额");
      const creditedUnits = safeInteger(row.credited_units, "累计获得积分");
      const debitedUnits = safeInteger(row.debited_units, "累计消耗积分");
      return {
        id: String(row.id),
        username: String(row.username),
        createdAt: safeInteger(row.created_at, "用户创建时间"),
        balanceUnits,
        balance: formatPointUnits(balanceUnits),
        creditedUnits,
        credited: formatPointUnits(creditedUnits),
        debitedUnits,
        debited: formatPointUnits(debitedUnits),
        lastChangedAt: row.last_changed_at === null || row.last_changed_at === undefined
          ? null
          : safeInteger(row.last_changed_at, "最近变动时间"),
      };
    }),
    total: Number(countRow?.total || 0),
    summary: {
      walletCount: Number(summary?.wallet_count || 0),
      totalBalanceUnits: safeInteger(summary?.total_balance_units || 0, "平台积分余额"),
      totalBalance: formatPointUnits(safeInteger(summary?.total_balance_units || 0, "平台积分余额")),
      attentionCount: Number(summary?.attention_count || 0),
      todayCredited: formatPointUnits(safeInteger(summary?.today_credited_units || 0, "今日入账积分")),
      todayDebited: formatPointUnits(safeInteger(summary?.today_debited_units || 0, "今日消耗积分")),
    },
  };
}

export async function listAdminPointLedger({ userId = "", limit = 20 } = {}) {
  const db = await getReadDb();
  const normalizedUserId = String(userId || "").trim().slice(0, 128);
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  let rows;
  if (db.dialect === "postgres") {
    const params = [];
    const where = normalizedUserId ? `WHERE l.user_id = $${params.push(normalizedUserId)}` : "";
    params.push(normalizedLimit);
    rows = await db.all(
      `SELECT l.*, u.username FROM point_ledger l
       LEFT JOIN users u ON u.id = l.user_id ${where}
       ORDER BY l.created_at DESC LIMIT $${params.length}`,
      params,
    );
  } else {
    rows = await db.all(
      `SELECT l.*, u.username FROM point_ledger l
       LEFT JOIN users u ON u.id = l.user_id ${normalizedUserId ? "WHERE l.user_id = ?" : ""}
       ORDER BY l.created_at DESC LIMIT ?`,
      normalizedUserId ? [normalizedUserId, normalizedLimit] : [normalizedLimit],
    );
  }
  return rows.map(publicLedgerEntry);
}

export async function adjustAdminUserPoints({ userId, mode, amount, reason, idempotencyKey, admin }) {
  const normalizedUserId = String(userId || "").trim().slice(0, 128);
  const normalizedMode = String(mode || "").trim();
  const normalizedReason = String(reason || "").trim().slice(0, 500);
  const normalizedKey = String(idempotencyKey || crypto.randomUUID()).trim().slice(0, 160);
  if (!normalizedUserId) throw new AdminPointsError(400, "missing-user-id", "缺少用户 ID");
  if (!["add", "deduct", "set"].includes(normalizedMode)) {
    throw new AdminPointsError(400, "invalid-adjustment-mode", "不支持的积分调整方式");
  }
  if (normalizedReason.length < 2) {
    throw new AdminPointsError(400, "missing-adjustment-reason", "请填写至少 2 个字的调整原因，方便后续追溯");
  }
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(normalizedKey)) {
    throw new AdminPointsError(400, "invalid-idempotency-key", "积分操作标识无效");
  }
  const requestedUnits = parseAdminPointAmount(amount, { allowZero: normalizedMode === "set" });

  return withDatabaseTransaction(async (tx) => {
    const placeholder = tx.dialect === "postgres" ? "$1" : "?";
    const user = await tx.get(`SELECT id, username FROM users WHERE id = ${placeholder}`, [normalizedUserId]);
    if (!user) throw new AdminPointsError(404, "user-not-found", "用户不存在");

    const existing = await tx.get(
      tx.dialect === "postgres"
        ? "SELECT * FROM point_ledger WHERE user_id = $1 AND idempotency_key = $2"
        : "SELECT * FROM point_ledger WHERE user_id = ? AND idempotency_key = ?",
      [normalizedUserId, `admin:${normalizedKey}`],
    );
    if (existing) {
      let metadata = {};
      try { metadata = JSON.parse(existing.metadata_json || "{}"); } catch { /* ignore invalid historical metadata */ }
      if (metadata.mode !== normalizedMode || Number(metadata.requestedUnits) !== requestedUnits || metadata.reason !== normalizedReason) {
        throw new AdminPointsError(409, "idempotency-conflict", "该操作标识已被另一笔积分调整使用");
      }
      return { replayed: true, user: { id: String(user.id), username: String(user.username) }, entry: publicLedgerEntry({ ...existing, username: user.username }) };
    }

    let wallet = await tx.get(
      tx.dialect === "postgres"
        ? "SELECT balance_units FROM point_wallets WHERE user_id = $1 FOR UPDATE"
        : "SELECT balance_units FROM point_wallets WHERE user_id = ?",
      [normalizedUserId],
    );
    const now = Date.now();
    if (!wallet) {
      await tx.run(
        tx.dialect === "postgres"
          ? "INSERT INTO point_wallets (user_id, balance_units, created_at, updated_at) VALUES ($1,0,$2,$2)"
          : "INSERT INTO point_wallets (user_id, balance_units, created_at, updated_at) VALUES (?,0,?,?)",
        tx.dialect === "postgres" ? [normalizedUserId, now] : [normalizedUserId, now, now],
      );
      wallet = { balance_units: 0 };
    }

    const previousBalanceUnits = safeInteger(wallet.balance_units, "原积分余额");
    let nextBalanceUnits;
    if (normalizedMode === "add") nextBalanceUnits = previousBalanceUnits + requestedUnits;
    else if (normalizedMode === "deduct") nextBalanceUnits = previousBalanceUnits - requestedUnits;
    else nextBalanceUnits = requestedUnits;
    if (!Number.isSafeInteger(nextBalanceUnits)) {
      throw new AdminPointsError(400, "point-balance-overflow", "调整后的积分超出安全范围");
    }
    if (nextBalanceUnits < 0) {
      throw new AdminPointsError(400, "insufficient-user-points", "扣减积分不能超过用户当前余额；如需清零，请使用“设为指定值”并填写 0");
    }
    const deltaUnits = nextBalanceUnits - previousBalanceUnits;
    if (deltaUnits === 0) throw new AdminPointsError(400, "no-point-change", "调整前后积分相同，无需提交");

    const metadata = JSON.stringify({
      reason: normalizedReason,
      mode: normalizedMode,
      requestedUnits,
      previousBalanceUnits,
      adminUserId: String(admin?.userId || ""),
      adminUsername: String(admin?.username || "admin"),
    });
    const ledgerId = crypto.randomUUID();
    if (tx.dialect === "postgres") {
      await tx.run("UPDATE point_wallets SET balance_units = $1, updated_at = $2 WHERE user_id = $3", [nextBalanceUnits, now, normalizedUserId]);
      await tx.run(
        `INSERT INTO point_ledger
         (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
         VALUES ($1,$2,NULL,'admin_adjustment',$3,$4,$5,$6,$7)`,
        [ledgerId, normalizedUserId, `admin:${normalizedKey}`, deltaUnits, nextBalanceUnits, metadata, now],
      );
    } else {
      await tx.run("UPDATE point_wallets SET balance_units = ?, updated_at = ? WHERE user_id = ?", [nextBalanceUnits, now, normalizedUserId]);
      await tx.run(
        `INSERT INTO point_ledger
         (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
         VALUES (?,?,NULL,'admin_adjustment',?,?,?,?,?)`,
        [ledgerId, normalizedUserId, `admin:${normalizedKey}`, deltaUnits, nextBalanceUnits, metadata, now],
      );
    }
    return {
      replayed: false,
      user: { id: String(user.id), username: String(user.username) },
      entry: publicLedgerEntry({
        id: ledgerId,
        user_id: normalizedUserId,
        username: user.username,
        entry_type: "admin_adjustment",
        delta_units: deltaUnits,
        balance_after_units: nextBalanceUnits,
        metadata_json: metadata,
        created_at: now,
      }),
    };
  });
}
