import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs from "sql.js";
import pg from "pg";
import { migrateAccountEditions } from "../accountEditionMigration.js";

const testUrl = process.env.ACCOUNT_EDITION_TEST_DATABASE_URL;
for (const dialect of ["sqlite", ...(testUrl ? ["postgres"] : [])]) {
  test(`${dialect} migration preserves old data, requires explicit ownership and is repeatable`, async (t) => {
    const previousEdition = process.env.LEGACY_ACCOUNT_EDITION;
    const previousMapping = process.env.ACCOUNT_EDITION_MAP_FILE;
    delete process.env.LEGACY_ACCOUNT_EDITION;
    delete process.env.ACCOUNT_EDITION_MAP_FILE;
    let tx, transaction;
    if (dialect === "postgres") {
      const client = new pg.Client({ connectionString: testUrl });
      await client.connect();
      const schema = `account_migration_test_${process.pid}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      tx = { dialect, run: (sql, params) => client.query(sql, params), all: async (sql, params) => (await client.query(sql, params)).rows, get: async (sql, params) => (await client.query(sql, params)).rows[0] };
      t.after(async () => { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); });
    } else {
      const SQL = await initSqlJs();
      const raw = new SQL.Database();
      const all = async (sql, params = []) => {
        const stmt = raw.prepare(sql);
        try { stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
        finally { stmt.free(); }
      };
      tx = { dialect, run: async (sql, params = []) => raw.run(sql, params), all, get: async (sql, params) => (await all(sql, params))[0] };
      t.after(() => raw.close());
    }
    transaction = async () => {
      await tx.run("BEGIN");
      try { await migrateAccountEditions(tx); await tx.run("COMMIT"); }
      catch (error) { await tx.run("ROLLBACK"); throw error; }
    };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cst-account-mapping-"));
    t.after(() => {
      for (const [key, value] of [["LEGACY_ACCOUNT_EDITION", previousEdition], ["ACCOUNT_EDITION_MAP_FILE", previousMapping]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await tx.run("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, email TEXT UNIQUE, phone TEXT UNIQUE, created_at BIGINT NOT NULL, legacy_note TEXT)");
    await tx.run("CREATE UNIQUE INDEX legacy_phone_unique ON users(phone)");
    await tx.run("CREATE INDEX legacy_created_index ON users(created_at)");
    await tx.run("CREATE TABLE user_wechat_identities (user_id TEXT PRIMARY KEY REFERENCES users(id), openid TEXT NOT NULL UNIQUE, unionid TEXT UNIQUE, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)");
    await tx.run("CREATE TABLE legacy_wallets (user_id TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER)");
    await tx.run("INSERT INTO users VALUES ('old-school','same_name','original-hash','same@example.com','13800138000',12345,'preserve-me'), ('old-finance','finance_name','finance-hash',NULL,NULL,23456,'also-preserve')");
    await tx.run("INSERT INTO user_wechat_identities VALUES ('old-school','same-openid','same-unionid',12345,12345)");
    await tx.run("INSERT INTO legacy_wallets VALUES ('old-school',98765)");
    await assert.rejects(transaction(), /旧账号缺少版本归属/);
    assert.equal((await tx.get("SELECT COUNT(*) AS count FROM users")).count, dialect === "postgres" ? "2" : 2);
    assert.equal((await tx.get("SELECT password_hash FROM users WHERE id = 'old-school'")).password_hash, "original-hash");
    const mapping = path.join(directory, "mapping.json");
    fs.writeFileSync(mapping, JSON.stringify({ "old-school": "school", "old-finance": "finance" }));
    process.env.ACCOUNT_EDITION_MAP_FILE = mapping;
    await transaction();
    assert.equal((await tx.get("SELECT edition FROM users WHERE id = 'old-finance'")).edition, "finance");
    assert.equal((await tx.get("SELECT legacy_note FROM users WHERE id = 'old-school'")).legacy_note, "preserve-me");
    assert.equal((await tx.get("SELECT balance FROM legacy_wallets")).balance, 98765);
    assert.equal((await tx.get("SELECT edition FROM user_wechat_identities")).edition, "school");
    await tx.run("INSERT INTO users (id, username, password_hash, email, phone, created_at, edition) VALUES ('new-enterprise','same_name','new-hash','same@example.com','13800138000',34567,'enterprise')");
    await tx.run("INSERT INTO user_wechat_identities (user_id,openid,unionid,created_at,updated_at,edition) VALUES ('new-enterprise','same-openid','same-unionid',34567,34567,'enterprise')");
    await assert.rejects(tx.run("INSERT INTO users (id, username, password_hash, phone, created_at, edition) VALUES ('duplicate','different_name','hash','13800138000',34567,'school')"));
    await assert.rejects(tx.run("INSERT INTO users (id, username, password_hash, created_at) VALUES ('unscoped','unscoped','hash',34567)"));
    delete process.env.ACCOUNT_EDITION_MAP_FILE;
    process.env.LEGACY_ACCOUNT_EDITION = "enterprise";
    await transaction();
    assert.equal((await tx.get("SELECT edition FROM users WHERE id = 'old-school'")).edition, "school");
    if (dialect === "sqlite") assert.deepEqual(await tx.all("PRAGMA foreign_key_check"), []);
  });
}
