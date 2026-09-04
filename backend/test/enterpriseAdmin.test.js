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
