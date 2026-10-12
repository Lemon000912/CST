import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-enterprise-admin-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";
process.env.APP_EDITION = "enterprise";

const { findUserByUsernameKey, initDatabase } = await import("../db.js");
const { verifyUserPassword } = await import("../auth.js");
const { seedEnterpriseAdminIfEnabled } = await import("../seedEnterpriseAdmin.js");

test("enterprise startup creates the default admin account once", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });

  await initDatabase();
  await seedEnterpriseAdminIfEnabled();
  const first = await findUserByUsernameKey("admin");
  assert.ok(first);
  assert.equal(await verifyUserPassword("admin123", first.password_hash), true);

  await seedEnterpriseAdminIfEnabled();
  const second = await findUserByUsernameKey("admin");
  assert.equal(second.id, first.id);
});

test("finance startup uses its own administrator configuration", async (t) => {
  const original = {
    APP_EDITION: process.env.APP_EDITION,
    FINANCE_ADMIN_USERNAME: process.env.FINANCE_ADMIN_USERNAME,
    FINANCE_ADMIN_PASSWORD: process.env.FINANCE_ADMIN_PASSWORD,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.APP_EDITION = "finance";
  process.env.FINANCE_ADMIN_USERNAME = "financeadmin";
  process.env.FINANCE_ADMIN_PASSWORD = "Finance_Test_123";

  await seedEnterpriseAdminIfEnabled();
  const account = await findUserByUsernameKey("financeadmin");
  assert.ok(account);
  assert.equal(await verifyUserPassword("Finance_Test_123", account.password_hash), true);
});
