import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-school-auth-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";
process.env.APP_EDITION = "school";
process.env.ADMIN_USERNAMES = "admin";

const { createUserRecord, initDatabase } = await import("../db.js");
const { handleLogin, hashUserPassword } = await import("../auth.js");

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("school login supports admin usernames and requires phone for regular users", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });

  await initDatabase();
  await createUserRecord("school-admin", "admin", await hashUserPassword("admin123"));
  await createUserRecord(
    "school-user",
    "student_user",
    await hashUserPassword("student123"),
    null,
    "13800138000",
  );

  const adminResponse = responseCapture();
  await handleLogin({ body: { username: "admin", password: "admin123" } }, adminResponse);
  assert.equal(adminResponse.statusCode, 200);
  assert.ok(adminResponse.body.token);

  const phoneResponse = responseCapture();
  await handleLogin({ body: { username: "13800138000", password: "student123" } }, phoneResponse);
  assert.equal(phoneResponse.statusCode, 200);
  assert.equal(phoneResponse.body.user.username, "student_user");

  const usernameResponse = responseCapture();
  await handleLogin({ body: { username: "student_user", password: "student123" } }, usernameResponse);
  assert.equal(usernameResponse.statusCode, 400);
  assert.equal(usernameResponse.body.code, "school-phone-login-required");
});
