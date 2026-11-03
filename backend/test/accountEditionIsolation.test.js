import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// An explicit URL is reserved for a disposable integration database.
const testUrl = process.env.ACCOUNT_EDITION_TEST_DATABASE_URL || "";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cst-account-editions-"));
Object.assign(process.env, {
  DATABASE_URL: testUrl, POSTGRES_URL: "", USE_POSTGRES: testUrl ? "true" : "false",
  SQLITE_FILE: path.join(directory, "accounts.sqlite"), APP_EDITION: "school",
  JWT_SECRET: "account-edition-tests-only-secret-at-least-32-characters", NODE_ENV: "test",
  ADMIN_USERNAMES: "", SEED_DEV_ADMIN: "0",
});
const db = await import("../db.js");
const auth = await import("../auth.js");
const { listAdminUsers, deleteAdminUser } = await import("../adminUsers.js");
const { listAdminPointUsers, listAdminPointLedger, adjustAdminUserPoints } = await import("../adminPoints.js");
const { setEnterpriseTier } = await import("../enterpriseTiers.js");
const { createWechatTicket, getWechatTicket } = await import("../wechatOAuth.js");
const editions = ["school", "enterprise", "finance"];
const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });

test("three editions have independent accounts, credentials, identities and administration", async (t) => {
  t.after(async () => {
    if (db.pgPool) await db.pgPool.end();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await db.initDatabase();
  const tokens = {};
  const identity = { openid: "shared-openid", unionid: "shared-unionid" };
  for (const edition of editions) {
    process.env.APP_EDITION = edition;
    // Before registration the other editions' matching phone and WeChat identity cannot log in.
    assert.equal(await db.findUserByPhone("13800138000"), null);
    assert.equal(await db.findUserByWechatIdentity(identity), null);
    const before = response();
    await auth.handleLogin({ body: { username: "13800138000", password: "Password-school" } }, before);
    assert.equal(before.body.code, "account-not-registered-in-edition");
    await db.createUserRecord(`${edition}-user`, "same_user", await auth.hashUserPassword(`Password-${edition}`), "same@example.com", "13800138000");
    await assert.rejects(db.createUserRecord(`${edition}-duplicate`, "different_user", "hash", null, "13800138000"));
    assert.equal((await db.findUserByUsernameKey("same_user")).id, `${edition}-user`);
    assert.equal((await db.findUserByEmail("same@example.com")).id, `${edition}-user`);
    const login = response();
    await auth.handleLogin({ body: { username: "13800138000", password: `Password-${edition}`, edition: "fake-client-edition" } }, login);
    assert.equal(login.statusCode, 200);
    tokens[edition] = login.body.token;
    const bound = await db.bindWechatIdentityByVerifiedPhone({ identity, phone: "13800138000" });
    assert.equal(bound.user.id, `${edition}-user`);
    assert.equal(bound.created, false);
    // The same new WeChat user must separately complete registration in each edition.
    const newIdentity = { openid: "shared-new-openid", unionid: "shared-new-unionid" };
    await assert.rejects(db.bindWechatIdentityByVerifiedPhone({ identity: newIdentity, phone: "13900139000" }), e => e.code === "wechat-new-account-details-required");
    const created = await db.bindWechatIdentityByVerifiedPhone({ identity: newIdentity, phone: "13900139000", newUser: { id: `${edition}-wechat`, username: "same_wechat", passwordHash: "hash", email: "wechat@example.com" } });
    assert.equal(created.created, true);
  }
  for (const edition of editions) {
    process.env.APP_EDITION = edition;
    assert.equal((await db.findUserByWechatIdentity(identity)).id, `${edition}-user`);
    assert.equal((await listAdminUsers()).total, 2);
    const pointUsers = await listAdminPointUsers();
    assert.equal(pointUsers.total, 2);
    assert.equal(pointUsers.summary.walletCount, 2);
    assert.equal((await listAdminPointLedger()).length, 2);
    const summary = await listAdminPointUsers({ search: "same_user" });
    assert.equal(summary.total, 1);
    for (const other of editions) {
      const verified = await auth.verifyAuthToken(tokens[other]);
      assert.equal(Boolean(verified), other === edition);
      const req = { headers: { authorization: `Bearer ${tokens[other]}` } };
      const me = response();
      await auth.handleMe(req, me);
      assert.equal(me.statusCode, edition === other ? 200 : 401);
      let nextCalled = false;
      const protectedResult = response();
      await auth.requireAuthenticatedUser(req, protectedResult, () => { nextCalled = true; });
      assert.equal(nextCalled, edition === other);
      assert.equal(await auth.resolveUserIdFromRequest(req), edition === other ? `${edition}-user` : "anonymous");
      if (other === edition) continue;
      assert.equal(await db.findUserById(`${other}-user`), null);
      assert.equal(await db.updateUserPassword(`${other}-user`, "attacker-password"), false);
      await db.updateUserInfo(`${other}-user`, { phone: "13700137000" });
      await assert.rejects(deleteAdminUser({ userId: `${other}-user`, adminUserId: `${edition}-user` }), e => e.status === 404);
      await assert.rejects(setEnterpriseTier({ userId: `${other}-user`, tiers: 1 }), e => e.status === 404);
      await assert.rejects(adjustAdminUserPoints({ userId: `${other}-user`, mode: "add", amount: "1", reason: "cross edition", idempotencyKey: "cross-edition-key", admin: { userId: `${edition}-user`, username: "admin" } }), e => e.status === 404);
      assert.deepEqual(await listAdminPointLedger({ userId: `${other}-user` }), []);
    }
  }
  process.env.APP_EDITION = "school";
  assert.equal((await db.findUserByPhone("13800138000")).id, "school-user");
  await db.updateUserPassword("school-user", await auth.hashUserPassword("School-New-Password"));
  process.env.APP_EDITION = "finance";
  const login = response();
  await auth.handleLogin({ body: { username: "13800138000", password: "Password-finance" } }, login);
  assert.equal(login.statusCode, 200);
  const ticket = createWechatTicket({ kind: "login", userId: "finance-user" });
  process.env.APP_EDITION = "enterprise";
  assert.equal(getWechatTicket(ticket.token), null);
  const { SignJWT } = await import("jose");
  const legacy = await new SignJWT({ name: "same_user" }).setProtectedHeader({ alg: "HS256" }).setSubject("school-user").setIssuer("paper-query").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.JWT_SECRET));
  assert.equal(await auth.verifyAuthToken(legacy), null);
  // Even a server-signed token for a foreign subject cannot access that account.
  const invalidSubject = await auth.signAuthToken("school-user", "same_user");
  const me = response();
  await auth.handleMe({ headers: { authorization: `Bearer ${invalidSubject}` } }, me);
  assert.equal(me.statusCode, 401);
  const readDb = db.pgPool ? { run: (sql) => db.pgPool.query(sql) } : await db.getSqliteDb();
  await readDb.run("INSERT INTO users (id,username,password_hash,created_at,edition) VALUES ('fk-user','fk_user','hash',1,'school')");
  await assert.rejects(readDb.run("INSERT INTO user_wechat_identities (user_id,openid,created_at,updated_at,edition) VALUES ('fk-user','wrong-edition-openid',1,1,'enterprise')"));
  await db.initDatabase(); // Restarts must not recreate global unique constraints.
});
