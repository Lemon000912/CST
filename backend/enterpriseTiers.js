import { getSqliteDb, pgPool, withDatabaseTransaction } from "./db.js";

export const ENTERPRISE_TIER_POINTS = 166_666;
export const ENTERPRISE_TIER_UNITS = ENTERPRISE_TIER_POINTS * 20;

export class EnterpriseTierError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function ensureEnterpriseTierSchema() {
  if (pgPool) {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS enterprise_point_tiers (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      tiers INTEGER NOT NULL CHECK (tiers >= 0),
      quota_year INTEGER NOT NULL,
      updated_at BIGINT NOT NULL
    )`);
  } else {
    const db = await getSqliteDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS enterprise_point_tiers (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      tiers INTEGER NOT NULL CHECK (tiers >= 0),
      quota_year INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }
}

export async function getEnterpriseTier(userId) {
  await ensureEnterpriseTierSchema();
  if (pgPool) {
    const { rows } = await pgPool.query("SELECT tiers, quota_year FROM enterprise_point_tiers WHERE user_id = $1", [userId]);
    return rows[0] ? { tiers: Number(rows[0].tiers), quotaYear: Number(rows[0].quota_year), assigned: true } : { tiers: 0, quotaYear: new Date().getFullYear(), assigned: false };
  }
  const db = await getSqliteDb();
  const row = await db.get("SELECT tiers, quota_year FROM enterprise_point_tiers WHERE user_id = ?", [userId]);
  return row ? { tiers: Number(row.tiers), quotaYear: Number(row.quota_year), assigned: true } : { tiers: 0, quotaYear: new Date().getFullYear(), assigned: false };
}

export async function listEnterpriseTiers(userIds) {
  await ensureEnterpriseTierSchema();
  if (!userIds.length) return new Map();
  if (pgPool) {
    const { rows } = await pgPool.query("SELECT user_id, tiers FROM enterprise_point_tiers WHERE user_id = ANY($1::text[])", [userIds]);
    return new Map(rows.map(row => [String(row.user_id), Number(row.tiers)]));
  }
  const db = await getSqliteDb();
  const placeholders = userIds.map(() => "?").join(",");
  const rows = await db.all(`SELECT user_id, tiers FROM enterprise_point_tiers WHERE user_id IN (${placeholders})`, userIds);
  return new Map(rows.map(row => [String(row.user_id), Number(row.tiers)]));
}

export async function setEnterpriseTier({ userId, tiers }) {
  const id = String(userId ?? "").trim();
  const count = Number(tiers);
  if (!id || !Number.isSafeInteger(count) || count < 0 || count > 10000) throw new EnterpriseTierError(400, "invalid-enterprise-tier", "挡位必须是 0 到 10000 的整数");
  await ensureEnterpriseTierSchema();
  const now = Date.now(), year = new Date().getFullYear(), quotaUnits = count * ENTERPRISE_TIER_UNITS;
  return withDatabaseTransaction(async tx => {
    const user = await tx.get(tx.dialect === "postgres" ? "SELECT id FROM users WHERE id = $1" : "SELECT id FROM users WHERE id = ?", [id]);
    if (!user) throw new EnterpriseTierError(404, "user-not-found", "用户不存在");
    const params = [id, count, year, now];
    await tx.run(tx.dialect === "postgres"
      ? `INSERT INTO enterprise_point_tiers(user_id, tiers, quota_year, updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET tiers=EXCLUDED.tiers, quota_year=EXCLUDED.quota_year, updated_at=EXCLUDED.updated_at`
      : `INSERT INTO enterprise_point_tiers(user_id, tiers, quota_year, updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET tiers=excluded.tiers, quota_year=excluded.quota_year, updated_at=excluded.updated_at`, params);
    await tx.run(tx.dialect === "postgres"
      ? `INSERT INTO point_wallets(user_id,balance_units,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(user_id) DO UPDATE SET balance_units=$2, updated_at=$3`
      : `INSERT INTO point_wallets(user_id,balance_units,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance_units=excluded.balance_units, updated_at=excluded.updated_at`,
    tx.dialect === "postgres" ? [id, quotaUnits, now] : [id, quotaUnits, now, now]);
    return { userId: id, tiers: count, annualPoints: count * ENTERPRISE_TIER_POINTS, quotaYear: year };
  });
}

export async function ensureEnterpriseAnnualQuota(userId) {
  const tier = await getEnterpriseTier(userId), year = new Date().getFullYear();
  if (tier.quotaYear === year && tier.assigned) return tier;
  const now = Date.now();
  await withDatabaseTransaction(async tx => {
    const ph = tx.dialect === "postgres" ? "$1" : "?";
    await tx.run(`UPDATE point_wallets SET balance_units = ${tx.dialect === "postgres" ? "$2" : "?"}, updated_at = ${tx.dialect === "postgres" ? "$3" : "?"} WHERE user_id = ${ph}`,
      tx.dialect === "postgres" ? [userId, tier.tiers * ENTERPRISE_TIER_UNITS, now] : [tier.tiers * ENTERPRISE_TIER_UNITS, now, userId]);
    await tx.run(tx.dialect === "postgres"
      ? "UPDATE enterprise_point_tiers SET quota_year=$1, updated_at=$2 WHERE user_id=$3"
      : "UPDATE enterprise_point_tiers SET quota_year=?, updated_at=? WHERE user_id=?",
    [year, now, userId]);
  });
  return { ...tier, quotaYear: year };
}
