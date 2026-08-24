import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("verified WeChat binding links existing phones and grants new users only once", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cst-wechat-binding-"));
  process.env.DATABASE_URL = "";
  process.env.POSTGRES_URL = "";
  process.env.USE_POSTGRES = "false";
  process.env.SQLITE_FILE = path.join(directory, "wechat-binding.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const dbModule = await import(`../db.js?wechat-binding-test=${Date.now()}`);
  await dbModule.initDatabase();

  await dbModule.createUserRecord(
    "existing-user",
    "existing_user",
    "password-hash",
    null,
    "13800138000",
  );
  const existingResult = await dbModule.bindWechatIdentityByVerifiedPhone({
    identity: { openid: "openid-existing", unionid: "unionid-existing", nickname: "已有用户" },
    phone: "13800138000",
    newUser: null,
  });
  assert.equal(existingResult.created, false);
  assert.equal(existingResult.user.id, "existing-user");
  assert.equal(
    (await dbModule.findUserByWechatIdentity({ openid: "openid-existing" }))?.id,
    "existing-user",
  );

  const newIdentity = { openid: "openid-new", unionid: "unionid-new", nickname: "新用户" };
  const newResult = await dbModule.bindWechatIdentityByVerifiedPhone({
    identity: newIdentity,
    phone: "13900139000",
    newUser: {
      id: "new-user",
      username: "new_user",
      passwordHash: "password-hash",
      email: null,
    },
  });
  assert.equal(newResult.created, true);
  assert.equal(newResult.user.id, "new-user");

  const repeated = await dbModule.bindWechatIdentityByVerifiedPhone({
    identity: newIdentity,
    phone: "13900139000",
    newUser: null,
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.alreadyLinked, true);

  const sqlite = await dbModule.getSqliteDb();
  const grants = await sqlite.get(
    "SELECT COUNT(*) AS count FROM point_ledger WHERE user_id = ? AND entry_type = 'signup_grant'",
    ["new-user"],
  );
  assert.equal(Number(grants.count), 1);
});
