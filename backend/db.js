/**
 * db.js
 * 统一数据库访问层：PostgreSQL（优先）或 SQLite（降级）
 */
import pg from "pg";
import crypto from "crypto";
import dotenv from "dotenv";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** SQLite 文件与 db.js 同目录下的 data/，不依赖进程 cwd */
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(__dirname, "data", "app.sqlite");

// 尝试加载 sqlite3，如果失败则使用 sql.js
try {
  var sqlite3 = await import("sqlite3");
  var { open } = await import("sqlite");
} catch (e) {
  console.log("[db] sqlite3 not available, using sql.js fallback");
}

const { Pool } = pg;

// ==================== 配置 ====================
const USE_POSTGRES = process.env.USE_POSTGRES === "true" || !!process.env.DATABASE_URL;
const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
export const INITIAL_POINT_GRANT_UNITS = 20_000;

// ==================== PostgreSQL 连接池 ====================
let pgPool = null;
if (POSTGRES_URL) {
  try {
    pgPool = new Pool({ connectionString: POSTGRES_URL });
    pgPool.on("error", (err) => {
      console.error("[db] PostgreSQL pool error:", err.message);
    });
    console.log("[db] PostgreSQL enabled:", POSTGRES_URL.replace(/\/\/.*@/, "//***@"));
  } catch (e) {
    console.error("[db] Failed to create PostgreSQL pool:", e.message);
    pgPool = null;
  }
} else {
  console.log("[db] PostgreSQL not enabled (POSTGRES_URL/DATABASE_URL not set)");
}

export function isPostgres() {
  return !!pgPool;
}

export { pgPool };

// ==================== SQLite 连接（降级）====================
let sqliteDbPromise = null;
let sqliteAccessTail = Promise.resolve();
let sqlJsLockFd;

function acquireSqlJsProcessLock() {
  const lockFile = `${SQLITE_FILE}.sqljs.lock`;
  fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      sqlJsLockFd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(sqlJsLockFd, String(process.pid));
      const release = () => {
        if (sqlJsLockFd === undefined) return;
        try {
          fs.closeSync(sqlJsLockFd);
        } catch {
          // Best-effort cleanup during process shutdown.
        }
        sqlJsLockFd = undefined;
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          // Best-effort cleanup during process shutdown.
        }
      };
      process.once("exit", release);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerPid;
      try {
        ownerPid = Number(fs.readFileSync(lockFile, "utf8"));
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0) process.kill(ownerPid, 0);
      } catch (ownerError) {
        if (ownerError?.code === "ESRCH") {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
        if (ownerError?.code && ownerError.code !== "EPERM") throw ownerError;
      }
      throw new Error(
        `sql.js database is already open by process ${ownerPid || "unknown"}; use PostgreSQL or native SQLite for multiple server processes`,
      );
    }
  }
  throw new Error("Unable to acquire sql.js database process lock");
}

/** Serialize access to the single SQLite connection, including reads. */
async function withSqliteAccess(task) {
  const previous = sqliteAccessTail;
  let release;
  sqliteAccessTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
}

function makeSqliteFacade(raw, transaction) {
  return {
    dialect: "sqlite",
    run: (sql, params = []) => withSqliteAccess(() => raw.run(sql, params)),
    get: (sql, params = []) => withSqliteAccess(() => raw.get(sql, params)),
    all: (sql, params = []) => withSqliteAccess(() => raw.all(sql, params)),
    exec: (sql) => withSqliteAccess(() => raw.exec(sql)),
    _transaction: (callback) => withSqliteAccess(() => transaction(callback)),
  };
}

export async function getSqliteDb() {
  if (!sqliteDbPromise) {
    sqliteDbPromise = (async () => {
      if (typeof open === "function" && sqlite3) {
        const db = await open({
          filename: SQLITE_FILE,
          driver: sqlite3.Database,
        });
        await db.exec("PRAGMA foreign_keys = ON");
        const raw = {
          run: (sql, params = []) => db.run(sql, params),
          get: (sql, params = []) => db.get(sql, params),
          all: (sql, params = []) => db.all(sql, params),
          exec: (sql) => db.exec(sql),
        };
        return makeSqliteFacade(raw, async (callback) => {
          await raw.exec("BEGIN IMMEDIATE");
          const tx = { dialect: "sqlite", ...raw };
          try {
            const result = await callback(tx);
            await raw.exec("COMMIT");
            return result;
          } catch (error) {
            try {
              await raw.exec("ROLLBACK");
            } catch {
              // Preserve the transaction error.
            }
            throw error;
          }
        });
      }

      // sql.js is an in-memory SQLite engine. Successful mutations are
      // atomically exported; transactions export exactly once after commit.
      acquireSqlJsProcessLock();
      const initSqlJs = await import("sql.js");
      const SQL = await initSqlJs.default();
      let db;
      const enableSqlJsForeignKeys = () => db.run("PRAGMA foreign_keys = ON");
      try {
        const data = fs.readFileSync(SQLITE_FILE);
        db = new SQL.Database(data);
      } catch (e) {
        if (e?.code === "ENOENT") {
          db = new SQL.Database();
        } else {
          throw new Error(
            `Refusing to replace unreadable SQLite database ${SQLITE_FILE}: ${e?.message || e}`,
          );
        }
      }
      enableSqlJsForeignKeys();

      const persistSqlJsDb = () => {
        fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
        const tempFile = `${SQLITE_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
        let fd;
        try {
          fd = fs.openSync(tempFile, "wx", 0o600);
          fs.writeFileSync(fd, Buffer.from(db.export()));
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = undefined;
          fs.renameSync(tempFile, SQLITE_FILE);
        } catch (error) {
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch {
              // Preserve the original persistence error.
            }
          }
          try {
            fs.rmSync(tempFile, { force: true });
          } catch {
            // Preserve the original persistence error.
          }
          throw error;
        }
      };

      const raw = {
        run: async (sql, params = []) => {
          db.run(sql, params);
          const lastIdResult = db.exec("SELECT last_insert_rowid() AS id");
          return {
            lastID: lastIdResult?.[0]?.values?.[0]?.[0],
            changes: db.getRowsModified(),
          };
        },
        get: async (sql, params = []) => {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            return stmt.step() ? stmt.getAsObject() : null;
          } finally {
            stmt.free();
          }
        },
        all: async (sql, params = []) => {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            const results = [];
            while (stmt.step()) results.push(stmt.getAsObject());
            return results;
          } finally {
            stmt.free();
          }
        },
        exec: async (sql) => {
          db.run(sql);
        },
      };

      const facade = makeSqliteFacade(
        {
          ...raw,
          run: async (sql, params = []) => {
            const result = await raw.run(sql, params);
            persistSqlJsDb();
            return result;
          },
          exec: async (sql) => {
            await raw.exec(sql);
            persistSqlJsDb();
          },
        },
        async (callback) => {
          const snapshot = db.export();
          try {
            await raw.exec("BEGIN IMMEDIATE");
            const result = await callback({ dialect: "sqlite", ...raw });
            await raw.exec("COMMIT");
            persistSqlJsDb();
            return result;
          } catch (error) {
            try {
              db.close();
            } catch {
              // Continue restoring the pre-transaction snapshot.
            }
            db = new SQL.Database(snapshot);
            enableSqlJsForeignKeys();
            throw error;
          }
        },
      );
      return facade;
    })();
  }
  return sqliteDbPromise;
}

/**
 * Run work atomically against the active application database.
 * PostgreSQL failures are propagated and never trigger a mid-request fallback.
 */
export async function withDatabaseTransaction(callback) {
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const tx = {
        dialect: "postgres",
        query: (sql, params = []) => client.query(sql, params),
        run: async (sql, params = []) => {
          const result = await client.query(sql, params);
          return { changes: result.rowCount, rows: result.rows };
        },
        get: async (sql, params = []) => {
          const result = await client.query(sql, params);
          return result.rows[0] || null;
        },
        all: async (sql, params = []) => {
          const result = await client.query(sql, params);
          return result.rows;
        },
      };
      const result = await callback(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  const db = await getSqliteDb();
  return db._transaction(callback);
}

// ==================== 初始化 ====================
export async function initDatabase() {
  if (pgPool) {
    let postgresReachable = false;
    let billingClient = null;
    try {
      await pgPool.query("SELECT 1");
      postgresReachable = true;
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS search_histories (
          id SERIAL PRIMARY KEY,
          query TEXT NOT NULL,
          source TEXT,
          result_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          email TEXT UNIQUE,
          phone TEXT UNIQUE,
          created_at BIGINT NOT NULL
        )
      `);
      // Older Material KB deployments used a timestamp-based users table and
      // did not have a phone column. CREATE TABLE IF NOT EXISTS does not
      // migrate an existing table, so normalize that legacy schema before any
      // authentication queries or registrations run.
      await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
      await pgPool.query(`
        DO $$
        DECLARE created_at_type TEXT;
        BEGIN
          SELECT data_type INTO created_at_type
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'users'
            AND column_name = 'created_at';

          IF created_at_type LIKE 'timestamp%' THEN
            ALTER TABLE users
              ALTER COLUMN created_at TYPE BIGINT
              USING CASE
                WHEN created_at IS NULL THEN (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
                ELSE (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT
              END;
          ELSIF created_at_type IN ('integer', 'smallint') THEN
            ALTER TABLE users
              ALTER COLUMN created_at TYPE BIGINT
              USING created_at::BIGINT;
          END IF;
        END $$
      `);
      await pgPool.query(`UPDATE users SET created_at = $1 WHERE created_at IS NULL`, [Date.now()]);
      await pgPool.query(`ALTER TABLE users ALTER COLUMN created_at SET NOT NULL`);
      await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username)`);
      await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)`);
      await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone)`);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS user_skill (
          user_id TEXT PRIMARY KEY,
          persona_id TEXT DEFAULT 'researcher',
          favorite_keywords TEXT,
          downloaded_papers TEXT,
          answer_feedback TEXT,
          updated_at BIGINT NOT NULL
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS user_downloaded_paper (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          paper_id TEXT NOT NULL,
          paper_title TEXT,
          doi TEXT,
          download_source TEXT,
          ts BIGINT NOT NULL,
          UNIQUE(user_id, paper_id)
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS user_answer_feedback (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          query TEXT,
          answer TEXT,
          feedback_value INTEGER NOT NULL,
          ts BIGINT NOT NULL
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS user_chat_sessions (
          user_id TEXT PRIMARY KEY,
          sessions_json TEXT NOT NULL,
          updated_at BIGINT NOT NULL,
          revision BIGINT NOT NULL DEFAULT 0,
          schema_version INTEGER NOT NULL DEFAULT 1
        )
      `);
      await pgPool.query(`ALTER TABLE user_chat_sessions ADD COLUMN IF NOT EXISTS revision BIGINT DEFAULT 0`);
      await pgPool.query(`ALTER TABLE user_chat_sessions ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1`);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS query_log (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT,
          query TEXT,
          filters TEXT,
          result_count INTEGER DEFAULT 0,
          latency_ms INTEGER DEFAULT 0,
          ts BIGINT NOT NULL
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS feedback (
          id BIGSERIAL PRIMARY KEY,
          message_id TEXT NOT NULL,
          user_id TEXT,
          channel TEXT,
          value INTEGER NOT NULL,
          ts BIGINT NOT NULL
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS client_logs (
          id BIGSERIAL PRIMARY KEY,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          stack TEXT,
          user_agent TEXT,
          url TEXT,
          timestamp TEXT,
          created_at BIGINT NOT NULL
        )
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS paper_pdf_files (
          paper_id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL DEFAULT 'application/pdf',
          byte_length BIGINT NOT NULL,
          sha256 TEXT NOT NULL,
          pdf_data BYTEA NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      billingClient = await pgPool.connect();
      await billingClient.query("BEGIN");
      await billingClient.query(`
        CREATE TABLE IF NOT EXISTS point_wallets (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
          balance_units BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
      await billingClient.query(`
        CREATE TABLE IF NOT EXISTS point_operations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          operation_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
          cost_units BIGINT,
          billing_details_json TEXT,
          result_json TEXT,
          receipt_json TEXT,
          error_code TEXT,
          lease_expires_at BIGINT,
          lease_token TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          completed_at BIGINT,
          UNIQUE(user_id, operation_type, idempotency_key)
        )
      `);
      await billingClient.query(`ALTER TABLE point_operations ADD COLUMN IF NOT EXISTS lease_token TEXT`);
      await billingClient.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS point_operations_one_processing_per_user
        ON point_operations(user_id) WHERE status = 'processing'
      `);
      await billingClient.query(`
        CREATE TABLE IF NOT EXISTS point_ledger (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          operation_id TEXT REFERENCES point_operations(id) ON DELETE RESTRICT,
          entry_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          delta_units BIGINT NOT NULL,
          balance_after_units BIGINT NOT NULL,
          metadata_json TEXT,
          created_at BIGINT NOT NULL,
          UNIQUE(user_id, idempotency_key)
        )
      `);
      await billingClient.query(`
        CREATE TABLE IF NOT EXISTS point_recharge_orders (
          id TEXT PRIMARY KEY,
          order_no TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          package_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('alipay', 'wechat')),
          idempotency_key TEXT NOT NULL,
          amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
          point_units BIGINT NOT NULL CHECK (point_units > 0),
          status TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'paid', 'failed', 'closed')),
          code_url TEXT,
          provider_order_id TEXT,
          provider_transaction_id TEXT,
          failure_code TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          paid_at BIGINT,
          UNIQUE(user_id, idempotency_key),
          UNIQUE(provider, provider_transaction_id)
        )
      `);
      await billingClient.query(`
        CREATE INDEX IF NOT EXISTS point_recharge_orders_user_created
        ON point_recharge_orders(user_id, created_at DESC)
      `);
      await billingClient.query(`
        CREATE OR REPLACE FUNCTION reject_point_ledger_mutation() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'point_ledger is immutable';
        END;
        $$ LANGUAGE plpgsql
      `);
      await billingClient.query(`
        DROP TRIGGER IF EXISTS point_ledger_immutable ON point_ledger;
        CREATE TRIGGER point_ledger_immutable
        BEFORE UPDATE OR DELETE ON point_ledger
        FOR EACH ROW EXECUTE FUNCTION reject_point_ledger_mutation()
      `);
      await billingClient.query(`
        CREATE OR REPLACE FUNCTION reject_point_ledger_truncate() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'point_ledger is immutable';
        END;
        $$ LANGUAGE plpgsql
      `);
      await billingClient.query(`
        DROP TRIGGER IF EXISTS point_ledger_no_truncate ON point_ledger;
        CREATE TRIGGER point_ledger_no_truncate
        BEFORE TRUNCATE ON point_ledger
        FOR EACH STATEMENT EXECUTE FUNCTION reject_point_ledger_truncate()
      `);
      await billingClient.query("COMMIT");
      billingClient.release();
      billingClient = null;
      await backfillPointWallets();
      databaseReady = true;
      console.log("[db] PostgreSQL tables initialized");
      return;
    } catch (e) {
      if (billingClient) {
        try {
          await billingClient.query("ROLLBACK");
        } catch {
          // Preserve the initialization error.
        }
        billingClient.release();
      }
      console.error("[db] PostgreSQL init error:", e.message);
      if (postgresReachable) {
        databaseReady = false;
        throw e;
      }
      if (!postgresReachable && (process.env.POSTGRES_URL || process.env.DATABASE_URL) && String(process.env.NODE_ENV ?? "").toLowerCase() === "production") {
        throw new Error(`[db] 生产环境 PostgreSQL 不可达，拒绝降级到 SQLite。请检查 DATABASE_URL 和 PostgreSQL 服务状态。原始错误: ${e.message}`);
      }
      if (pgPool) {
        try {
          await pgPool.end();
        } catch (_) {
          /* ignore */
        }
        pgPool = null;
      }
      console.warn("[db] PostgreSQL 不可连接，降级为 SQLite（请检查服务是否启动、DATABASE_URL 是否正确）");
    }
  }

  // SQLite 降级初始化
  try {
    const db = await getSqliteDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS search_histories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        source TEXT,
        result_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT UNIQUE,
        created_at INTEGER NOT NULL
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_skill (
        user_id TEXT PRIMARY KEY,
        persona_id TEXT DEFAULT 'researcher',
        favorite_keywords TEXT,
        downloaded_papers TEXT,
        answer_feedback TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_downloaded_paper (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        paper_id TEXT NOT NULL,
        paper_title TEXT,
        doi TEXT,
        download_source TEXT,
        ts INTEGER NOT NULL,
        UNIQUE(user_id, paper_id)
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_answer_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        query TEXT,
        answer TEXT,
        feedback_value INTEGER NOT NULL,
        ts INTEGER NOT NULL
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS user_chat_sessions (
        user_id TEXT PRIMARY KEY,
        sessions_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 1
      )
    `);
    try {
      await db.exec(`ALTER TABLE user_chat_sessions ADD COLUMN revision INTEGER DEFAULT 0`);
    } catch (_) { /* column already exists */ }
    try {
      await db.exec(`ALTER TABLE user_chat_sessions ADD COLUMN schema_version INTEGER DEFAULT 1`);
    } catch (_) { /* column already exists */ }
    await db.exec(`
      CREATE TABLE IF NOT EXISTS point_wallets (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
        balance_units INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS point_operations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        operation_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        cost_units INTEGER,
        billing_details_json TEXT,
        result_json TEXT,
        receipt_json TEXT,
        error_code TEXT,
        lease_expires_at INTEGER,
        lease_token TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(user_id, operation_type, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS point_operations_one_processing_per_user
      ON point_operations(user_id) WHERE status = 'processing';
      CREATE TABLE IF NOT EXISTS point_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        operation_id TEXT REFERENCES point_operations(id) ON DELETE RESTRICT,
        entry_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        delta_units INTEGER NOT NULL,
        balance_after_units INTEGER NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS point_recharge_orders (
        id TEXT PRIMARY KEY,
        order_no TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        package_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('alipay', 'wechat')),
        idempotency_key TEXT NOT NULL,
        amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
        point_units INTEGER NOT NULL CHECK (point_units > 0),
        status TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'paid', 'failed', 'closed')),
        code_url TEXT,
        provider_order_id TEXT,
        provider_transaction_id TEXT,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        paid_at INTEGER,
        UNIQUE(user_id, idempotency_key),
        UNIQUE(provider, provider_transaction_id)
      );
      CREATE INDEX IF NOT EXISTS point_recharge_orders_user_created
      ON point_recharge_orders(user_id, created_at DESC);
      CREATE TRIGGER IF NOT EXISTS point_ledger_no_update
      BEFORE UPDATE ON point_ledger
      BEGIN SELECT RAISE(ABORT, 'point_ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS point_ledger_no_delete
      BEFORE DELETE ON point_ledger
      BEGIN SELECT RAISE(ABORT, 'point_ledger is immutable'); END
    `);
    try {
      await db.exec(`ALTER TABLE point_operations ADD COLUMN lease_token TEXT`);
    } catch (_) {
      /* Existing database already has the lease fencing column. */
    }
    // papers 表（本地文献库）
    await db.exec(`
      CREATE TABLE IF NOT EXISTS papers (
        paper_id TEXT PRIMARY KEY,
        doi TEXT,
        title TEXT NOT NULL,
        abstract TEXT,
        year INTEGER,
        venue TEXT,
        oa_status TEXT,
        source_batch TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        arxiv_id TEXT,
        authors_json TEXT,
        abs_url TEXT,
        pdf_url TEXT,
        patent_number TEXT
      )
    `);
    // 兼容升级：旧表缺少 patent_number 列时自动添加
    try {
      await db.exec(`ALTER TABLE papers ADD COLUMN patent_number TEXT`);
    } catch (_) {
      /* 列已存在则忽略 */
    }
    // query_log 表
    await db.exec(`
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        query TEXT,
        filters TEXT,
        result_count INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        ts INTEGER NOT NULL
      )
    `);
    // feedback 表
    await db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        user_id TEXT,
        channel TEXT,
        value INTEGER NOT NULL,
        ts INTEGER NOT NULL
      )
    `);
    // pdf_download_log 表
    await db.exec(`
      CREATE TABLE IF NOT EXISTS pdf_download_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        paper_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        user_agent TEXT,
        url TEXT,
        timestamp TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    console.log("[db] SQLite tables initialized");
  } catch (e) {
    console.error("[db] SQLite init error:", e.message);
    databaseReady = false;
    throw e;
  }

  await backfillPointWallets();
  databaseReady = true;
}

// ==================== 搜索历史 ====================
export async function saveSearchHistory(query, source, resultCount) {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO search_histories (query, source, result_count, created_at) VALUES ($1,$2,$3,NOW())`,
      [query, source || null, resultCount || 0]
    );
  } else {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO search_histories (query, source, result_count) VALUES (?,?,?)`,
      [query, source || null, resultCount || 0]
    );
  }
}

export async function getSearchHistory(limit = 50) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT id, query, source, result_count, created_at FROM search_histories ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows;
  } else {
    const db = await getSqliteDb();
    return await db.all(
      `SELECT id, query, source, result_count, created_at FROM search_histories ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );
  }
}

// ==================== 用户认证 ====================
export async function createUserRecord(id, username, passwordHash, email = null, phone = null) {
  const ts = Date.now();
  return withDatabaseTransaction(async (tx) => {
    if (tx.dialect === "postgres") {
      await tx.run(
        `INSERT INTO users (id, username, password_hash, email, phone, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, username, passwordHash, email, phone, ts],
      );
      await tx.run(
        `INSERT INTO point_wallets (user_id, balance_units, created_at, updated_at) VALUES ($1,$2,$3,$3)`,
        [id, INITIAL_POINT_GRANT_UNITS, ts],
      );
      await tx.run(
        `INSERT INTO point_ledger
         (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
         VALUES ($1,$2,NULL,'signup_grant',$3,$4,$4,$5,$6)`,
        [crypto.randomUUID(), id, "signup_grant", INITIAL_POINT_GRANT_UNITS, JSON.stringify({ reason: "signup" }), ts],
      );
    } else {
      await tx.run(
        `INSERT INTO users (id, username, password_hash, email, phone, created_at) VALUES (?,?,?,?,?,?)`,
        [id, username, passwordHash, email, phone, ts],
      );
      await tx.run(
        `INSERT INTO point_wallets (user_id, balance_units, created_at, updated_at) VALUES (?,?,?,?)`,
        [id, INITIAL_POINT_GRANT_UNITS, ts, ts],
      );
      await tx.run(
        `INSERT INTO point_ledger
         (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
         VALUES (?,?,NULL,'signup_grant',?,?,?,?,?)`,
        [crypto.randomUUID(), id, "signup_grant", INITIAL_POINT_GRANT_UNITS, INITIAL_POINT_GRANT_UNITS, JSON.stringify({ reason: "signup" }), ts],
      );
    }
    return { id, username, balanceUnits: INITIAL_POINT_GRANT_UNITS };
  });
}

/** Development-only helper used by the seeded test administrator. */
export async function setDevelopmentPointBalance(userId, balanceUnits) {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId || !Number.isSafeInteger(balanceUnits) || balanceUnits < 0) {
    throw new TypeError("Development point balance requires a user id and a non-negative safe integer");
  }
  const ts = Date.now();
  if (pgPool) {
    const result = await pgPool.query(
      `UPDATE point_wallets SET balance_units = $1, updated_at = $2 WHERE user_id = $3`,
      [balanceUnits, ts, normalizedUserId],
    );
    if (result.rowCount !== 1) throw new Error("Development administrator wallet was not found");
    return;
  }
  const db = await getSqliteDb();
  const result = await db.run(
    `UPDATE point_wallets SET balance_units = ?, updated_at = ? WHERE user_id = ?`,
    [balanceUnits, ts, normalizedUserId],
  );
  if (Number(result?.changes) !== 1) throw new Error("Development administrator wallet was not found");
}

async function backfillPointWallets() {
  const ts = Date.now();
  await withDatabaseTransaction(async (tx) => {
    if (tx.dialect === "postgres") {
      await tx.run(
        `WITH created_wallets AS (
           INSERT INTO point_wallets (user_id, balance_units, created_at, updated_at)
           SELECT u.id, $1, $2, $2 FROM users u
           WHERE NOT EXISTS (SELECT 1 FROM point_wallets w WHERE w.user_id = u.id)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING user_id, balance_units
         )
         INSERT INTO point_ledger
         (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
         SELECT md5(random()::text || clock_timestamp()::text || cw.user_id), cw.user_id, NULL,
                'backfill_grant', 'backfill_grant', $1, cw.balance_units, $3, $2
         FROM created_wallets cw
         ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
        [INITIAL_POINT_GRANT_UNITS, ts, JSON.stringify({ reason: "existing_user_backfill" })],
      );
    } else {
      const missingUsers = await tx.all(
        `SELECT u.id FROM users u LEFT JOIN point_wallets w ON w.user_id = u.id WHERE w.user_id IS NULL`,
      );
      for (const user of missingUsers) {
        await tx.run(
          `INSERT INTO point_wallets (user_id, balance_units, created_at, updated_at) VALUES (?,?,?,?)`,
          [user.id, INITIAL_POINT_GRANT_UNITS, ts, ts],
        );
        await tx.run(
          `INSERT INTO point_ledger
           (id, user_id, operation_id, entry_type, idempotency_key, delta_units, balance_after_units, metadata_json, created_at)
           VALUES (?,?,NULL,'backfill_grant',?,?,?,?,?)`,
          [crypto.randomUUID(), user.id, "backfill_grant", INITIAL_POINT_GRANT_UNITS, INITIAL_POINT_GRANT_UNITS, JSON.stringify({ reason: "existing_user_backfill" }), ts],
        );
      }
    }
  });
}

export async function findUserByUsernameKey(username) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT id, username, password_hash, created_at FROM users WHERE username = $1`,
      [username]
    );
    return r.rows[0] || null;
  } else {
    const db = await getSqliteDb();
    return await db.get(
      `SELECT id, username, password_hash, created_at FROM users WHERE username = ?`,
      [username]
    );
  }
}

export async function findUserById(id) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT id, username, created_at FROM users WHERE id = $1`,
      [id]
    );
    return r.rows[0] || null;
  } else {
    const db = await getSqliteDb();
    return await db.get(
      `SELECT id, username, created_at FROM users WHERE id = ?`,
      [id]
    );
  }
}

export async function listAllUsers() {
  if (pgPool) {
    const r = await pgPool.query(`SELECT id, username, created_at FROM users ORDER BY created_at DESC`);
    return r.rows;
  } else {
    const db = await getSqliteDb();
    return await db.all(`SELECT id, username, created_at FROM users ORDER BY created_at DESC`);
  }
}

// ==================== 用户偏好设置 ====================
export async function getUserPreferences(userId) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT favorite_topics, notification_enabled FROM user_preferences WHERE user_id = $1`,
      [userId]
    );
    return r.rows[0] || null;
  } else {
    const db = await getSqliteDb();
    return await db.get(
      `SELECT favorite_topics, notification_enabled FROM user_preferences WHERE user_id = ?`,
      [userId]
    );
  }
}

export async function saveUserPreferences(userId, prefs) {
  const id = crypto.randomUUID();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO user_preferences (id, user_id, favorite_topics, notification_enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         favorite_topics = EXCLUDED.favorite_topics,
         notification_enabled = EXCLUDED.notification_enabled`,
      [id, userId, prefs.favoriteTopics || null, prefs.notificationEnabled ?? true]
    );
  } else {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO user_preferences (id, user_id, favorite_topics, notification_enabled)
       VALUES (?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         favorite_topics = excluded.favorite_topics,
         notification_enabled = excluded.notification_enabled`,
      [id, userId, prefs.favoriteTopics || null, prefs.notificationEnabled ?? true]
    );
  }
}

// ==================== 扩展功能：本地文献数据库查询 ====================

export async function findDoiRecord(doi) {
  if (!pgPool) return null;
  const r = await pgPool.query(
    `SELECT id, title, doi, authors, journal, year, publish_date, url, imported_at FROM doi_records WHERE doi = $1 LIMIT 1`,
    [doi]
  );
  return r.rows[0] || null;
}

export async function searchDoiRecords(q, limit = 50) {
  if (!pgPool) return [];
  // 支持化学式（如 TiO2）、普通单词、中文
  const words = String(q ?? "").toLowerCase().match(/[a-z0-9\u4e00-\u9fff]{2,}/g) || [];
  const stopWords = new Set(["the", "and", "for", "with", "from", "via", "using", "based", "new", "high", "low"]);
  const keywords = [...new Set(words)].filter(w => !stopWords.has(w) && w.length >= 2).slice(0, 10);

  if (keywords.length === 0) {
    const like = `%${q.replace(/%/g, "").slice(0, 200)}%`;
    const r = await pgPool.query(
      `SELECT id, title, doi, authors, journal, year, publish_date, url FROM doi_records
       WHERE title ILIKE $1 OR authors ILIKE $2 OR journal ILIKE $3 ORDER BY year DESC NULLS LAST LIMIT $4`,
      [like, like, like, limit]
    );
    return r.rows;
  }

  const conditions = keywords.map((_, i) =>
    `(title ILIKE $${i * 3 + 1} OR authors ILIKE $${i * 3 + 2} OR journal ILIKE $${i * 3 + 3})`
  ).join(" OR ");
  const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`]);
  params.push(limit);

  const sql = `SELECT id, title, doi, authors, journal, year, publish_date, url FROM doi_records WHERE ${conditions} ORDER BY year DESC NULLS LAST LIMIT $${params.length}`;
  const r = await pgPool.query(sql, params);
  return r.rows;
}

export async function searchCategoryPapers(category, q, limit = 20) {
  if (!pgPool) return [];
  const validCategories = ['chemistry_catalyst', 'materials_science', 'physics_optics', 'nano_materials', 'top_journals', 'energy_electrochem', 'computational_theory', 'metals_alloys', 'ceramics_inorganic'];
  if (!validCategories.includes(category)) return [];
  const like = `%${q.replace(/%/g, "").slice(0, 200)}%`;
  const r = await pgPool.query(
    `SELECT * FROM ${category} WHERE title ILIKE $1 OR abstract ILIKE $2 OR authors ILIKE $3 ORDER BY year DESC NULLS LAST LIMIT $4`,
    [like, like, like, limit]
  );
  return r.rows;
}

export async function searchFullPapers(q, limit = 50) {
  if (!pgPool) return [];
  // Some material_kb snapshots use doi_records plus category tables and do
  // not contain the newer optional `papers` table. Treat that layout as a
  // supported database variant instead of failing the entire DB search.
  const tableCheck = await pgPool.query(`SELECT to_regclass('public.papers') AS table_name`);
  if (!tableCheck.rows[0]?.table_name) return [];
  const query = String(q ?? "").trim();
  const words = query.toLowerCase().match(/[a-z0-9][a-z0-9+\-]{1,}/g) || [];
  const stopWords = new Set([
    "the", "and", "for", "with", "from", "what", "which", "how", "why", "does", "do",
    "are", "is", "was", "were", "has", "have", "can", "could", "would", "about", "after",
    "please", "paper", "papers", "database", "research", "result", "results", "compare", "based",
  ]);
  const bilingualTerms = [];
  if (/铝合金/.test(query)) bilingualTerms.push("aluminum", "aluminium", "alloy");
  if (/力学性能|机械性能/.test(query)) bilingualTerms.push("mechanical", "properties");
  if (/焊接/.test(query)) bilingualTerms.push("weld", "welding");
  if (/腐蚀/.test(query)) bilingualTerms.push("corrosion");
  if (/磨损/.test(query)) bilingualTerms.push("wear");
  if (/裂纹/.test(query)) bilingualTerms.push("crack");
  if (/热处理/.test(query)) bilingualTerms.push("heat", "treatment");
  const keywords = [...new Set([...words.filter((word) => !stopWords.has(word)), ...bilingualTerms])].slice(0, 12);
  if (!keywords.length) return [];

  const fields = ["title", "abstract", "material_name", "properties", "applications"];
  const params = [];
  const conditions = keywords.map((keyword) => {
    const fieldConditions = fields.map((field) => {
      params.push(`%${keyword.replace(/%/g, "")}%`);
      return `${field} ILIKE $${params.length}`;
    });
    return `(${fieldConditions.join(" OR ")})`;
  });
  const queryRelevance = conditions.map((condition) => `(CASE WHEN ${condition} THEN 1 ELSE 0 END)`).join(" + ");
  params.push(Math.min(150, Math.max(1, Number(limit) || 50)));
  const r = await pgPool.query(
    `SELECT paper_id, doi, title, abstract, year, venue, journal, authors_json, category, material_name, symmetry_phase, structure_descriptor, properties, applications, synthesis_method, characterization_method, quality_control, first_author, corresponding_author, citation_count, download_count, relevance_score, credibility_score, oa_status, abs_url, pdf_url, (${queryRelevance}) AS query_relevance
       FROM papers
      WHERE ${conditions.join(" OR ")}
      ORDER BY query_relevance DESC, relevance_score DESC, citation_count DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function getPaperPdfFile(paperId) {
  if (!pgPool) return null;
  const result = await pgPool.query(
    `SELECT paper_id, filename, content_type, byte_length, sha256, pdf_data
       FROM paper_pdf_files WHERE paper_id = $1 LIMIT 1`,
    [String(paperId ?? "").trim()],
  );
  return result.rows[0] || null;
}

/**
 * 查询本地 SQLite papers 表（降级）
 * 支持长查询拆分为关键词进行 OR 匹配，并按匹配关键词数量排序
 */
export async function searchLocalPapers(q, limit = 50) {
  const db = await getSqliteDb();
  const query = String(q ?? "").trim();

  // 提取关键词：支持英文单词、化学式、中文
  const words = query.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]{2,}/g) || [];
  const stopWords = new Set(["the", "and", "for", "with", "from", "via", "using", "based", "new", "high", "low", "are", "was", "has", "not", "can", "use", "may", "all", "any", "this", "that", "into"]);
  const keywords = [...new Set(words)].filter(w => !stopWords.has(w) && w.length >= 2).slice(0, 10);

  // 如果没有提取到关键词，使用原始查询（可能是符号或非常短的查询）
  if (keywords.length === 0) {
    const like = `%${query.replace(/%/g, "").slice(0, 200)}%`;
    return await db.all(
      `SELECT paper_id, doi, title, abstract as summary, year, venue as journal, authors_json as authors, source_batch as source, created_at as published, pdf_url, abs_url, patent_number FROM papers WHERE title LIKE ? OR abstract LIKE ? OR authors_json LIKE ? ORDER BY year DESC LIMIT ?`,
      [like, like, like, limit]
    );
  }

  // 构建多关键词 OR 查询，并按匹配数量排序（匹配越多关键词越靠前）
  const matchScores = keywords.map((k, i) =>
    `(CASE WHEN title LIKE ? THEN 3 ELSE 0 END + CASE WHEN abstract LIKE ? THEN 2 ELSE 0 END + CASE WHEN authors_json LIKE ? THEN 1 ELSE 0 END)`
  ).join(" + ");

  const conditions = keywords.map(() =>
    `(title LIKE ? OR abstract LIKE ? OR authors_json LIKE ?)`
  ).join(" OR ");

  const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`]);
  // 为匹配分数添加参数（需要两套参数）
  const scoreParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`]);
  const allParams = [...scoreParams, ...params, limit];

  return await db.all(
    `SELECT paper_id, doi, title, abstract as summary, year, venue as journal, authors_json as authors, source_batch as source, created_at as published, pdf_url, abs_url, patent_number,
     (${matchScores}) as relevance_score
     FROM papers WHERE ${conditions} ORDER BY relevance_score DESC, year DESC LIMIT ?`,
    allParams
  );
}

// ==================== 扩展功能：MCP相关论文数据库 ====================

export async function saveMcpDocument({ userId, filename, filePath, fileSize, fileType, title, doi, extractedText, summary, keywords }) {
  if (!pgPool) return;
  const id = crypto.randomUUID();
  await pgPool.query(
    `INSERT INTO documents (id, filename, file_path, file_size, file_type, title, doi, upload_by, extracted_text, summary, keywords, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
    [id, filename, filePath, fileSize, fileType, title, doi, userId, extractedText, summary, keywords]
  );
  return id;
}

export async function getMcpDocuments(userId, limit = 50) {
  if (!pgPool) return [];
  const r = await pgPool.query(
    `SELECT id, filename, title, doi, file_size, file_type, summary, keywords, created_at FROM documents WHERE upload_by = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

export async function saveAnalysisResult({ userId, paperId, analysisType, result }) {
  if (!pgPool) return;
  const id = crypto.randomUUID();
  await pgPool.query(
    `INSERT INTO analysis_results (id, user_id, paper_id, analysis_type, result_json, created_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
    [id, userId, paperId, analysisType, JSON.stringify(result)]
  );
  return id;
}

export async function getAnalysisResults(paperId) {
  if (!pgPool) return [];
  const r = await pgPool.query(
    `SELECT id, analysis_type, result_json, created_at FROM analysis_results WHERE paper_id = $1 ORDER BY created_at DESC`,
    [paperId]
  );
  return r.rows;
}

export async function saveRecommendation({ userId, query, recommendationType, content, confidence, reason }) {
  if (!pgPool) return;
  const id = crypto.randomUUID();
  await pgPool.query(
    `INSERT INTO recommendations (id, user_id, query, recommendation_type, content, confidence, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [id, userId, query, recommendationType, content, confidence, reason]
  );
  return id;
}

export async function getUserRecommendations(userId, limit = 50) {
  if (!pgPool) return [];
  const r = await pgPool.query(
    `SELECT id, query, recommendation_type, content, confidence, reason, is_accepted, created_at FROM recommendations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

// ==================== 工具函数 ====================

export async function query(sql, params = []) {
  if (!pgPool) throw new Error("仅PostgreSQL模式支持原始SQL查询");
  const r = await pgPool.query(sql, params);
  return r.rows;
}

export async function getDatabaseStats() {
  if (!pgPool) return { backend: "sqlite", tables: [] };
  const tables = await pgPool.query(
    `SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::regclass)) as size FROM pg_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(tablename::regclass) DESC LIMIT 20`
  );
  const counts = await pgPool.query(
    `SELECT tablename, n_tup_ins - n_tup_del as row_count FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY row_count DESC NULLS LAST LIMIT 20`
  );
  return { backend: "postgresql", database: "material_kb", tables: tables.rows, rowCounts: counts.rows };
}

// ==================== 用户特征Skill相关函数 ====================

export async function saveUserSkill(userId, skillData) {
  const ts = Date.now();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO user_skill (user_id, persona_id, favorite_keywords, downloaded_papers, answer_feedback, updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET persona_id = EXCLUDED.persona_id, favorite_keywords = EXCLUDED.favorite_keywords, downloaded_papers = EXCLUDED.downloaded_papers, answer_feedback = EXCLUDED.answer_feedback, updated_at = EXCLUDED.updated_at`,
      [userId, skillData.personaId || 'researcher', skillData.favoriteKeywords || null, skillData.downloadedPapers || null, skillData.answerFeedback || null, ts]
    );
  } else {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO user_skill (user_id, persona_id, favorite_keywords, downloaded_papers, answer_feedback, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET persona_id = excluded.persona_id, favorite_keywords = excluded.favorite_keywords, downloaded_papers = excluded.downloaded_papers, answer_feedback = excluded.answer_feedback, updated_at = excluded.updated_at`,
      [userId, skillData.personaId || 'researcher', skillData.favoriteKeywords || null, skillData.downloadedPapers || null, skillData.answerFeedback || null, ts]
    );
  }
}

export async function getUserSkill(userId) {
  if (pgPool) {
    const r = await pgPool.query(`SELECT user_id, persona_id, favorite_keywords, downloaded_papers, answer_feedback, updated_at FROM user_skill WHERE user_id = $1`, [userId]);
    return r.rows[0] || null;
  } else {
    const db = await getSqliteDb();
    return await db.get(`SELECT user_id, persona_id, favorite_keywords, downloaded_papers, answer_feedback, updated_at FROM user_skill WHERE user_id = ?`, [userId]);
  }
}

export async function recordDownloadedPaper(userId, paperData) {
  const ts = Date.now();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO user_downloaded_paper (user_id, paper_id, paper_title, doi, download_source, ts) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, paper_id) DO NOTHING`,
      [userId, paperData.paperId, paperData.title || null, paperData.doi || null, paperData.source || null, ts]
    );
  } else {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO user_downloaded_paper (user_id, paper_id, paper_title, doi, download_source, ts) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, paper_id) DO NOTHING`,
      [userId, paperData.paperId, paperData.title || null, paperData.doi || null, paperData.source || null, ts]
    );
  }
}

export async function getUserDownloadedPapers(userId, limit = 50) {
  if (pgPool) {
    const r = await pgPool.query(`SELECT id, paper_id, paper_title, doi, download_source, ts FROM user_downloaded_paper WHERE user_id = $1 ORDER BY ts DESC LIMIT $2`, [userId, limit]);
    return r.rows;
  } else {
    const db = await getSqliteDb();
    return await db.all(`SELECT id, paper_id, paper_title, doi, download_source, ts FROM user_downloaded_paper WHERE user_id = ? ORDER BY ts DESC LIMIT ?`, [userId, limit]);
  }
}

export async function recordAnswerFeedback(userId, feedbackData) {
  const ts = Date.now();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO user_answer_feedback (user_id, query, answer, feedback_value, ts) VALUES ($1,$2,$3,$4,$5)`,
      [userId, feedbackData.query || null, feedbackData.answer || null, feedbackData.value, ts]
    );
  } else {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO user_answer_feedback (user_id, query, answer, feedback_value, ts) VALUES (?,?,?,?,?)`,
      [userId, feedbackData.query || null, feedbackData.answer || null, feedbackData.value, ts]
    );
  }
}

export async function getUserAnswerFeedback(userId, limit = 50) {
  if (pgPool) {
    const r = await pgPool.query(`SELECT id, query, answer, feedback_value, ts FROM user_answer_feedback WHERE user_id = $1 ORDER BY ts DESC LIMIT $2`, [userId, limit]);
    return r.rows;
  } else {
    const db = await getSqliteDb();
    return await db.all(`SELECT id, query, answer, feedback_value, ts FROM user_answer_feedback WHERE user_id = ? ORDER BY ts DESC LIMIT ?`, [userId, limit]);
  }
}

export async function updateUserInfo(userId, userInfo) {
  if (pgPool) {
    const fields = [];
    const values = [];
    let idx = 1;
    if (userInfo.email !== undefined) { fields.push(`email = $${idx++}`); values.push(userInfo.email); }
    if (userInfo.phone !== undefined) { fields.push(`phone = $${idx++}`); values.push(userInfo.phone); }
    if (fields.length === 0) return;
    values.push(userId);
    await pgPool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  } else {
    const db = await getSqliteDb();
    const fields = [];
    const values = [];
    if (userInfo.email !== undefined) { fields.push('email = ?'); values.push(userInfo.email); }
    if (userInfo.phone !== undefined) { fields.push('phone = ?'); values.push(userInfo.phone); }
    if (fields.length === 0) return;
    values.push(userId);
    await db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  }
}

export async function findUserByPhone(phone) {
  if (pgPool) {
    const r = await pgPool.query('SELECT id, username, email, phone, created_at FROM users WHERE phone = $1', [phone]);
    return r.rows[0] || null;
  } else {
    const db = await getSqliteDb();
    return await db.get('SELECT id, username, email, phone, created_at FROM users WHERE phone = ?', [phone]);
  }
}

export async function findUserByEmail(email) {
  if (pgPool) {
    const r = await pgPool.query('SELECT id, username, email, phone, created_at FROM users WHERE email = $1', [email]);
    return r.rows[0] || null;
  } else {
    const db = await getSqliteDb();
    return await db.get('SELECT id, username, email, phone, created_at FROM users WHERE email = ?', [email]);
  }
}

export function normalizeUsernameKey(raw) {
  return String(raw ?? "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "").slice(0, 32);
}

// ==================== 缺失的补充函数 ====================

let databaseReady = false;

export function isDatabaseReady() {
  return databaseReady;
}

/** PostgreSQL material_kb.papers（与 searchFullPapers 字段对齐） */
async function upsertPapersPostgres(rows, sourceBatch = "") {
  if (!pgPool || !Array.isArray(rows) || rows.length === 0) return { ok: 0, fail: 0 };
  let ok = 0;
  let fail = 0;
  const ts = Date.now();
  for (const row of rows) {
    try {
      await pgPool.query(
        `INSERT INTO papers (paper_id, doi, title, abstract, year, journal, authors_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (paper_id) DO UPDATE SET
           doi = EXCLUDED.doi,
           title = EXCLUDED.title,
           abstract = EXCLUDED.abstract,
           year = EXCLUDED.year,
           journal = EXCLUDED.journal,
           authors_json = EXCLUDED.authors_json`,
        [
          row.paper_id,
          row.doi || null,
          row.title || "",
          row.abstract || "",
          row.year || null,
          row.venue || row.journal || "Web",
          row.authors_json || "[]",
        ],
      );
      ok++;
    } catch (e) {
      fail++;
      if (fail <= 3) console.warn("[upsertPapers] PostgreSQL skip:", e.message, row.paper_id);
    }
  }
  return { ok, fail };
}

/** 批量插入或更新 papers 表（SQLite；若已配置 PostgreSQL 则同步写入 material_kb.papers） */
export async function upsertPapers(rows, sourceBatch = "") {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const db = await getSqliteDb();
  for (const row of rows) {
    try {
      await db.run(
        `INSERT INTO papers (paper_id, doi, title, abstract, year, venue, oa_status, source_batch, created_at, updated_at, arxiv_id, authors_json, abs_url, pdf_url, patent_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(paper_id) DO UPDATE SET
           doi = excluded.doi,
           title = excluded.title,
           abstract = excluded.abstract,
           year = excluded.year,
           venue = excluded.venue,
           oa_status = excluded.oa_status,
           source_batch = excluded.source_batch,
           updated_at = excluded.updated_at,
           arxiv_id = excluded.arxiv_id,
           authors_json = excluded.authors_json,
           abs_url = excluded.abs_url,
           pdf_url = excluded.pdf_url,
           patent_number = excluded.patent_number`,
        [
          row.paper_id,
          row.doi || null,
          row.title || "",
          row.abstract || "",
          row.year || null,
          row.venue || null,
          row.oa_status || null,
          sourceBatch,
          row.created_at || Date.now(),
          Date.now(),
          row.arxiv_id || null,
          row.authors_json || "[]",
          row.abs_url || null,
          row.pdf_url || null,
          row.patentNumber || row.patent_number || null,
        ]
      );
    } catch (e) {
      console.warn("[upsertPapers] skip row:", e.message, row.paper_id);
    }
  }
  if (pgPool) {
    const pg = await upsertPapersPostgres(rows, sourceBatch);
    if (pg.ok) console.log(`[upsertPapers] PostgreSQL synced ${pg.ok} row(s)`);
  }
}

/** 记录查询日志 */
export async function logQuery({ userId, query, filters, resultCount, latencyMs }) {
  try {
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO query_log (user_id, query, filters, result_count, latency_ms, ts) VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId || null, query || "", JSON.stringify(filters || {}), resultCount || 0, latencyMs || 0, Date.now()],
      );
      return;
    }
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO query_log (user_id, query, filters, result_count, latency_ms, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId || null, query || "", JSON.stringify(filters || {}), resultCount || 0, latencyMs || 0, Date.now()],
    );
  } catch (e) {
    // query_log 表可能不存在，静默忽略
  }
}

/** 插入反馈 */
export async function insertFeedback({ messageId, userId, channel, value }) {
  try {
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO feedback (message_id, user_id, channel, value, ts) VALUES ($1,$2,$3,$4,$5)`,
        [messageId, userId || null, channel || "", value, Date.now()],
      );
      return;
    }
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO feedback (message_id, user_id, channel, value, ts) VALUES (?, ?, ?, ?, ?)`,
      [messageId, userId || null, channel || "", value, Date.now()],
    );
  } catch (e) {
    // feedback 表可能不存在，静默忽略
  }
}

/** 记录 PDF 下载 */
export async function logPdfDownload(userId, paperId) {
  try {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO pdf_download_log (user_id, paper_id, ts) VALUES (?, ?, ?)`,
      [userId || null, paperId, Date.now()]
    );
  } catch (e) {
    // pdf_download_log 表可能不存在，静默忽略
  }
}

/** 统计某时间后的 PDF 下载数 */
export async function countPdfDownloadsSince(userId, sinceMs) {
  try {
    const db = await getSqliteDb();
    const row = await db.get(
      `SELECT COUNT(*) as count FROM pdf_download_log WHERE user_id = ? AND ts >= ?`,
      [userId || null, sinceMs]
    );
    return row?.count || 0;
  } catch (e) {
    return 0;
  }
}

/** 读取用户聊天会话（后端持久化，重启不丢） */
export async function getUserChatSessions(userId) {
  if (!userId || userId === "anonymous") return null;
  try {
    if (pgPool) {
      const r = await pgPool.query(
        `SELECT sessions_json, updated_at, revision, schema_version FROM user_chat_sessions WHERE user_id = $1`,
        [userId],
      );
      if (!r.rows.length) return null;
      return {
        sessionsJson: r.rows[0].sessions_json,
        updatedAt: Number(r.rows[0].updated_at) || 0,
        revision: Number(r.rows[0].revision) || 0,
        schemaVersion: Number(r.rows[0].schema_version) || 1,
      };
    }
    const db = await getSqliteDb();
    const row = await db.get(
      `SELECT sessions_json, updated_at, revision, schema_version FROM user_chat_sessions WHERE user_id = ?`,
      [userId],
    );
    if (!row) return null;
    return {
      sessionsJson: row.sessions_json,
      updatedAt: Number(row.updated_at) || 0,
      revision: Number(row.revision) || 0,
      schemaVersion: Number(row.schema_version) || 1,
    };
  } catch (e) {
    console.warn("[db] getUserChatSessions failed", e?.message || e);
    return null;
  }
}

/** 保存用户聊天会话（支持乐观并发控制）
 * @param {string} userId
 * @param {string} sessionsJson
 * @param {number} [updatedAt] - ignored; server clock is always used
 * @param {number|null} [baseRevision] - if a non-negative integer, conditional update; null = legacy unconditional
 * @returns {{ ok: boolean, revision?: number, updatedAt?: number, conflict?: boolean, sessions_json?: string }}
 */
export async function saveUserChatSessions(userId, sessionsJson, updatedAt = Date.now(), baseRevision = null) {
  if (!userId || userId === "anonymous") return { ok: false };
  const serverTs = Date.now();
  const isConditional = typeof baseRevision === "number" && Number.isFinite(baseRevision) && baseRevision >= 0;
  try {
    if (pgPool) {
      if (isConditional) {
        // Conditional update: only succeeds if revision matches
        const upd = await pgPool.query(
          `UPDATE user_chat_sessions
           SET sessions_json = $1, updated_at = $2, revision = revision + 1, schema_version = 2
           WHERE user_id = $3 AND revision = $4
           RETURNING revision, updated_at`,
          [sessionsJson, serverTs, userId, baseRevision],
        );
        if (upd.rowCount > 0) {
          return { ok: true, revision: Number(upd.rows[0].revision), updatedAt: Number(upd.rows[0].updated_at) };
        }
        // Check if row exists at all
        const cur = await pgPool.query(
          `SELECT revision, sessions_json, updated_at FROM user_chat_sessions WHERE user_id = $1`,
          [userId],
        );
        if (!cur.rows.length) {
          // No row yet — do first insert
          const ins = await pgPool.query(
            `INSERT INTO user_chat_sessions (user_id, sessions_json, updated_at, revision, schema_version)
             VALUES ($1, $2, $3, 1, 2) RETURNING revision, updated_at`,
            [userId, sessionsJson, serverTs],
          );
          return { ok: true, revision: Number(ins.rows[0].revision), updatedAt: Number(ins.rows[0].updated_at) };
        }
        // Conflict: return current server state
        return {
          ok: false,
          conflict: true,
          revision: Number(cur.rows[0].revision),
          sessions_json: cur.rows[0].sessions_json,
          updatedAt: Number(cur.rows[0].updated_at),
        };
      }
      // Legacy unconditional upsert — still increments revision
      const res = await pgPool.query(
        `INSERT INTO user_chat_sessions (user_id, sessions_json, updated_at, revision, schema_version)
         VALUES ($1, $2, $3, 1, 2)
         ON CONFLICT (user_id) DO UPDATE SET
           sessions_json = EXCLUDED.sessions_json,
           updated_at = $3,
           revision = user_chat_sessions.revision + 1,
           schema_version = 2
         RETURNING revision, updated_at`,
        [userId, sessionsJson, serverTs],
      );
      return { ok: true, revision: Number(res.rows[0].revision), updatedAt: Number(res.rows[0].updated_at) };
    }

    // SQLite path
    const db = await getSqliteDb();
    if (isConditional) {
      const upd = await db.run(
        `UPDATE user_chat_sessions
         SET sessions_json = ?, updated_at = ?, revision = revision + 1, schema_version = 2
         WHERE user_id = ? AND revision = ?`,
        [sessionsJson, serverTs, userId, baseRevision],
      );
      if ((upd?.changes ?? 0) > 0) {
        const row = await db.get(
          `SELECT revision, updated_at FROM user_chat_sessions WHERE user_id = ?`,
          [userId],
        );
        return { ok: true, revision: Number(row?.revision ?? 0), updatedAt: Number(row?.updated_at ?? serverTs) };
      }
      // Check if row exists
      const cur = await db.get(
        `SELECT revision, sessions_json, updated_at FROM user_chat_sessions WHERE user_id = ?`,
        [userId],
      );
      if (!cur) {
        // No row yet — first insert
        await db.run(
          `INSERT INTO user_chat_sessions (user_id, sessions_json, updated_at, revision, schema_version)
           VALUES (?, ?, ?, 1, 2)`,
          [userId, sessionsJson, serverTs],
        );
        return { ok: true, revision: 1, updatedAt: serverTs };
      }
      return {
        ok: false,
        conflict: true,
        revision: Number(cur.revision),
        sessions_json: cur.sessions_json,
        updatedAt: Number(cur.updated_at),
      };
    }
    // Legacy unconditional upsert for SQLite
    await db.run(
      `INSERT INTO user_chat_sessions (user_id, sessions_json, updated_at, revision, schema_version)
       VALUES (?, ?, ?, 1, 2)
       ON CONFLICT(user_id) DO UPDATE SET
         sessions_json = excluded.sessions_json,
         updated_at = excluded.updated_at,
         revision = user_chat_sessions.revision + 1,
         schema_version = 2`,
      [userId, sessionsJson, serverTs],
    );
    const row = await db.get(
      `SELECT revision, updated_at FROM user_chat_sessions WHERE user_id = ?`,
      [userId],
    );
    return { ok: true, revision: Number(row?.revision ?? 1), updatedAt: Number(row?.updated_at ?? serverTs) };
  } catch (e) {
    console.warn("[db] saveUserChatSessions failed", e?.message || e);
    return { ok: false };
  }
}
