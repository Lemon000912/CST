import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `enterprise-tiers-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { createUserRecord, getSqliteDb, initDatabase } = await import("../db.js");
const { ensureEnterpriseAnnualQuota, setEnterpriseTier } = await import("../enterpriseTiers.js");

test("administrator tiers set a fixed annual quota and zero tiers disable usage", async (t) => {
  t.after(() => { try { fs.rmSync(sqliteFile, { force: true }); } catch {} });
  await initDatabase();
  const id = "enterprise-tier-user";
  await createUserRecord(id, "enterprise_tier_user", "unused");
  const db = await getSqliteDb();

  const assigned = await setEnterpriseTier({ userId: id, tiers: 3 });
  assert.equal(assigned.annualPoints, 499_998);
  assert.equal(Number((await db.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [id])).balance_units), 9_999_960);

  await db.run("UPDATE point_wallets SET balance_units = 123 WHERE user_id = ?", [id]);
  await db.run("UPDATE enterprise_point_tiers SET quota_year = ? WHERE user_id = ?", [new Date().getFullYear() - 1, id]);
  await ensureEnterpriseAnnualQuota(id);
  assert.equal(Number((await db.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [id])).balance_units), 9_999_960);

  await setEnterpriseTier({ userId: id, tiers: 0 });
  assert.equal(Number((await db.get("SELECT balance_units FROM point_wallets WHERE user_id = ?", [id])).balance_units), 0);
  await assert.rejects(setEnterpriseTier({ userId: id, tiers: 1.5 }), /挡位/);
});
