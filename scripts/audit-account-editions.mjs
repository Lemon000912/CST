// Read-only ownership audit: usage history is evidence, never an automatic assignment.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import initSqlJs from "sql.js";

dotenv.config({ quiet: true });
const editions = new Set(["school", "enterprise", "finance"]);
const outputFlag = process.argv.indexOf("--output");
const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : "";
if (outputFlag >= 0 && (!output || output.startsWith("--"))) throw new Error("--output 需要文件路径");
let client, sqlite;
try {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  let all, columns;
  if (url) {
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    all = async (sql) => (await client.query(sql)).rows;
    columns = async (table) => (await client.query("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [table])).rows;
  } else {
    const SQL = await initSqlJs();
    // Import a snapshot in memory; never open the live file for writing or export it.
    sqlite = new SQL.Database(fs.readFileSync(process.env.SQLITE_FILE || "backend/data/app.sqlite"));
    all = async (sql) => {
      const stmt = sqlite.prepare(sql);
      try { const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
      finally { stmt.free(); }
    };
    columns = async (table) => all(`PRAGMA table_info(${table})`);
  }
  const userColumns = await columns("users");
  const hasEdition = userColumns.some(c => c.name === "edition");
  const users = await all(`SELECT id, username, created_at${hasEdition ? ", edition" : ""} FROM users ORDER BY created_at`);
  const evidence = new Map(users.map(u => [String(u.id), new Set()]));
  for (const table of ["user_chat_sessions_by_edition", "user_chat_session_items"]) {
    if (!(await columns(table)).some(c => c.name === "edition")) continue;
    for (const row of await all(`SELECT DISTINCT user_id, edition FROM ${table}`)) {
      if (editions.has(row.edition)) evidence.get(String(row.user_id))?.add(row.edition);
    }
  }
  if ((await columns("point_operations")).some(c => c.name === "billing_details_json")) {
    for (const row of await all("SELECT user_id, billing_details_json FROM point_operations WHERE billing_details_json IS NOT NULL")) {
      try {
        const edition = JSON.parse(row.billing_details_json)?.edition;
        if (editions.has(edition)) evidence.get(String(row.user_id))?.add(edition);
      } catch { /* An old malformed billing record cannot establish ownership. */ }
    }
  }
  const accounts = users.map(user => ({
    id: String(user.id), username: user.username, createdAt: user.created_at,
    assignedEdition: editions.has(user.edition) ? user.edition : null,
    observedEditions: [...evidence.get(String(user.id))].sort(),
  }));
  const report = {
    note: "历史使用版本仅供核对，不等同于注册归属。未分配的账号需要确认；不要直接将本报告作为迁移映射。",
    total: accounts.length, unassigned: accounts.filter(a => !a.assignedEdition).length,
    accounts,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, { flag: "wx" });
    console.log(`已生成只读核对报告：${target}；共 ${report.total} 个账号，${report.unassigned} 个待确认。`);
  } else console.log(text);
  if (client) await client.query("ROLLBACK");
} catch (error) {
  console.error(`账号版本核对失败（未修改数据库）：${error.code || error.name}`);
  process.exitCode = 1;
} finally {
  if (client) await client.end();
  sqlite?.close();
}
