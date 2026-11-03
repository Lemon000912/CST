import fs from "node:fs";
import { APP_EDITIONS } from "./appEdition.js";

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

// Never infer ownership from whichever backend happens to start first.
function legacyAssignments(users) {
  const fallback = String(process.env.LEGACY_ACCOUNT_EDITION ?? "").trim();
  const file = String(process.env.ACCOUNT_EDITION_MAP_FILE ?? "").trim();
  const mapping = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return users.map((user) => {
    const edition = user.edition || mapping[user.id] || fallback;
    if (!APP_EDITIONS.includes(edition)) {
      throw new Error("旧账号缺少版本归属：请设置 LEGACY_ACCOUNT_EDITION=school|enterprise|finance，或通过 ACCOUNT_EDITION_MAP_FILE 提供账号 ID 到版本的 JSON 映射；不会自动复制账号。");
    }
    return [user.id, edition];
  });
}

async function removeGlobalUniqueIndexes(tx, table, columns) {
  // Discover both constraint-backed and standalone indexes, including legacy names.
  const indexes = await tx.all(`
    SELECT i.relname AS name, c.conname AS constraint_name, a.attname AS column_name
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
    LEFT JOIN pg_constraint c ON c.conindid = x.indexrelid
    WHERE n.nspname = current_schema() AND t.relname = $1
      AND x.indisunique AND NOT x.indisprimary AND x.indnatts = 1`, [table]);
  for (const index of indexes) {
    if (!columns.includes(index.column_name)) continue;
    await tx.run(index.constraint_name
      ? `ALTER TABLE ${quote(table)} DROP CONSTRAINT ${quote(index.constraint_name)}`
      : `DROP INDEX ${quote(index.name)}`);
  }
}

async function rebuildSqliteTable(tx, table, uniqueColumns, constraints) {
  // Preserve extra legacy columns, indexes and triggers while removing only the
  // old single-column UNIQUE rules. Rebuilding is necessary for SQLite autoindexes.
  const original = await tx.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  const objects = await tx.all("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL", [table]);
  const discarded = new Set();
  for (const index of await tx.all(`PRAGMA index_list(${quote(table)})`)) {
    if (!index.unique || index.origin === "pk") continue;
    const columns = await tx.all(`PRAGMA index_info(${quote(index.name)})`);
    if (columns.length === 1 && uniqueColumns.includes(columns[0].name)) discarded.add(index.name);
  }
  let sql = original.sql;
  for (const column of uniqueColumns) {
    sql = sql.replace(new RegExp(`(\\b${column}\\s+[^,]*?)\\s+UNIQUE\\b`, "gi"), "$1");
    sql = sql.replace(new RegExp(`,\\s*(?:CONSTRAINT\\s+\\w+\\s+)?UNIQUE\\s*\\(\\s*["\x60\\[]?${column}["\x60\\]]?\\s*\\)`, "gi"), "");
  }
  const replacement = `${table}_edition_new`;
  sql = sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i, `CREATE TABLE ${quote(replacement)}`);
  sql = sql.replace(/\)\s*$/, `, ${constraints.join(", ")})`);
  await tx.run(sql);
  const columns = (await tx.all(`PRAGMA table_info(${quote(table)})`)).map(c => quote(c.name)).join(", ");
  await tx.run(`INSERT INTO ${quote(replacement)} (${columns}) SELECT ${columns} FROM ${quote(table)}`);
  await tx.run(`DROP TABLE ${quote(table)}`);
  await tx.run(`ALTER TABLE ${quote(replacement)} RENAME TO ${quote(table)}`);
  for (const object of objects) if (!discarded.has(object.name)) await tx.run(object.sql);
}

export async function migrateAccountEditions(tx) {
  if (tx.dialect === "postgres") await tx.run("SELECT pg_advisory_xact_lock(764203119)");
  await tx.run("CREATE TABLE IF NOT EXISTS account_edition_migrations (version INTEGER PRIMARY KEY)");
  if (await tx.get("SELECT version FROM account_edition_migrations WHERE version = 1")) return;
  const postgres = tx.dialect === "postgres";
  if (postgres) {
    await tx.run("LOCK TABLE users, user_wechat_identities IN ACCESS EXCLUSIVE MODE");
    await tx.run("ALTER TABLE users ADD COLUMN IF NOT EXISTS edition TEXT");
    await tx.run("ALTER TABLE user_wechat_identities ADD COLUMN IF NOT EXISTS edition TEXT");
  } else {
    for (const table of ["users", "user_wechat_identities"]) {
      const columns = await tx.all(`PRAGMA table_info(${table})`);
      if (!columns.some(c => c.name === "edition")) await tx.run(`ALTER TABLE ${table} ADD COLUMN edition TEXT`);
      if (table === "users" && !columns.some(c => c.name === "phone")) await tx.run("ALTER TABLE users ADD COLUMN phone TEXT");
    }
  }
  const assignments = legacyAssignments(await tx.all("SELECT id, edition FROM users"));
  for (const [id, edition] of assignments) {
    await tx.run(postgres ? "UPDATE users SET edition = $1 WHERE id = $2" : "UPDATE users SET edition = ? WHERE id = ?", [edition, id]);
  }
  await tx.run("UPDATE user_wechat_identities SET edition = (SELECT edition FROM users WHERE users.id = user_wechat_identities.user_id)");
  const check = "CHECK (edition IS NOT NULL AND edition IN ('school', 'enterprise', 'finance'))";
  if (postgres) {
    await removeGlobalUniqueIndexes(tx, "users", ["username", "email", "phone"]);
    await removeGlobalUniqueIndexes(tx, "user_wechat_identities", ["openid", "unionid"]);
    for (const table of ["users", "user_wechat_identities"]) {
      await tx.run(`ALTER TABLE ${table} ALTER COLUMN edition SET NOT NULL`);
      await tx.run(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_edition_check ${check}`);
    }
    await tx.run("ALTER TABLE users ADD CONSTRAINT users_id_edition_unique UNIQUE (id, edition)");
    for (const column of ["username", "email", "phone"]) await tx.run(`CREATE UNIQUE INDEX users_${column}_edition_unique ON users (edition, ${column})`);
    for (const column of ["openid", "unionid"]) await tx.run(`CREATE UNIQUE INDEX wechat_${column}_edition_unique ON user_wechat_identities (edition, ${column})`);
    await tx.run("ALTER TABLE user_wechat_identities ADD CONSTRAINT wechat_user_edition_fk FOREIGN KEY (user_id, edition) REFERENCES users (id, edition)");
  } else {
    await rebuildSqliteTable(tx, "users", ["username", "email", "phone"], [check, "UNIQUE (id, edition)", ...["username", "email", "phone"].map(c => `UNIQUE (edition, ${c})`)]);
    await rebuildSqliteTable(tx, "user_wechat_identities", ["openid", "unionid"], [check, "UNIQUE (edition, openid)", "UNIQUE (edition, unionid)", "FOREIGN KEY (user_id, edition) REFERENCES users (id, edition)"]);
    if ((await tx.all("PRAGMA foreign_key_check")).length) throw new Error("账号版本迁移外键检查失败，已回滚");
  }
  await tx.run("INSERT INTO account_edition_migrations (version) VALUES (1)");
}
