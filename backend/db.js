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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** SQLite 文件与 db.js 同目录下的 data/，不依赖进程 cwd */
const SQLITE_FILE = path.join(__dirname, "data", "app.sqlite");

// 尝试加载 sqlite3，如果失败则使用 sql.js
try {
  var sqlite3 = await import("sqlite3");
  var { open } = await import("sqlite");
} catch (e) {
  console.log("[db] sqlite3 not available, using sql.js fallback");
}

dotenv.config();

const { Pool } = pg;

// ==================== 配置 ====================
const USE_POSTGRES = process.env.USE_POSTGRES === "true" || !!process.env.DATABASE_URL;
const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;

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
export async function getSqliteDb() {
  if (!sqliteDbPromise) {
    if (typeof open === "function" && sqlite3) {
      // 使用 sqlite3
      sqliteDbPromise = open({
        filename: SQLITE_FILE,
        driver: sqlite3.Database,
      });
    } else {
      // 使用 sql.js 作为降级
      const initSqlJs = await import("sql.js");
      const SQL = await initSqlJs.default();
      let db;
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

      // sql.js is an in-memory SQLite engine. Every successful mutation must
      // be exported to disk before the API reports success. Write to a new
      // file and atomically rename it so a crash cannot leave a partial DB.
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

      sqliteDbPromise = Promise.resolve({
        run: async (sql, params = []) => {
          db.run(sql, params);
          persistSqlJsDb();
          const lastIdResult = db.exec("SELECT last_insert_rowid() AS id");
          return { lastID: lastIdResult?.[0]?.values?.[0]?.[0] };
        },
        get: async (sql, params = []) => {
          const stmt = db.prepare(sql);
          stmt.bind(params);
          const result = stmt.step() ? stmt.getAsObject() : null;
          stmt.free();
          return result;
        },
        all: async (sql, params = []) => {
          const stmt = db.prepare(sql);
          stmt.bind(params);
          const results = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        },
        exec: async (sql) => {
          db.run(sql);
          persistSqlJsDb();
        },
      });
    }
  }
  return sqliteDbPromise;
}

// ==================== 初始化 ====================
export async function initDatabase() {
  if (pgPool) {
    try {
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
          updated_at BIGINT NOT NULL
        )
      `);
      console.log("[db] PostgreSQL tables initialized");
    } catch (e) {
      console.error("[db] PostgreSQL init error:", e.message);
      if (pgPool) {
        try {
          await pgPool.end();
        } catch (_) {
          /* ignore */
        }
        pgPool = null;
      }
      console.warn("[db] 已关闭 PostgreSQL 连接池并降级为 SQLite（请检查服务是否启动、DATABASE_URL 是否正确）");
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
        updated_at INTEGER NOT NULL
      )
    `);
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
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO users (id, username, password_hash, email, phone, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, username, passwordHash, email, phone, ts]
    );
  } else {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO users (id, username, password_hash, email, phone, created_at) VALUES (?,?,?,?,?,?)`,
      [id, username, passwordHash, email, phone, ts]
    );
  }
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
  const like = `%${q.replace(/%/g, "").slice(0, 200)}%`;
  const r = await pgPool.query(
    `SELECT paper_id, doi, title, abstract, year, journal, authors_json, category, material_name, symmetry_phase, structure_descriptor, properties, applications, synthesis_method, characterization_method, quality_control, first_author, corresponding_author, citation_count, download_count, relevance_score, credibility_score FROM papers WHERE title ILIKE $1 OR abstract ILIKE $2 OR authors_json ILIKE $3 OR material_name ILIKE $1 OR properties ILIKE $2 OR applications ILIKE $3 ORDER BY relevance_score DESC, citation_count DESC NULLS LAST LIMIT $4`,
    [like, like, like, limit]
  );
  return r.rows;
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
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO query_log (user_id, query, filters, result_count, latency_ms, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      [userId || null, query || "", JSON.stringify(filters || {}), resultCount || 0, latencyMs || 0, Date.now()]
    );
  } catch (e) {
    // query_log 表可能不存在，静默忽略
  }
}

/** 插入反馈 */
export async function insertFeedback({ messageId, userId, channel, value }) {
  try {
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO feedback (message_id, user_id, channel, value, ts) VALUES (?, ?, ?, ?, ?)`,
      [messageId, userId || null, channel || "", value, Date.now()]
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
        `SELECT sessions_json, updated_at FROM user_chat_sessions WHERE user_id = $1`,
        [userId],
      );
      if (!r.rows.length) return null;
      return {
        sessionsJson: r.rows[0].sessions_json,
        updatedAt: Number(r.rows[0].updated_at) || 0,
      };
    }
    const db = await getSqliteDb();
    const row = await db.get(
      `SELECT sessions_json, updated_at FROM user_chat_sessions WHERE user_id = ?`,
      [userId],
    );
    if (!row) return null;
    return {
      sessionsJson: row.sessions_json,
      updatedAt: Number(row.updated_at) || 0,
    };
  } catch (e) {
    console.warn("[db] getUserChatSessions failed", e?.message || e);
    return null;
  }
}

/** 保存用户聊天会话 */
export async function saveUserChatSessions(userId, sessionsJson, updatedAt = Date.now()) {
  if (!userId || userId === "anonymous") return false;
  const ts = Number(updatedAt) || Date.now();
  try {
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO user_chat_sessions (user_id, sessions_json, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET sessions_json = EXCLUDED.sessions_json, updated_at = EXCLUDED.updated_at`,
        [userId, sessionsJson, ts],
      );
      return true;
    }
    const db = await getSqliteDb();
    await db.run(
      `INSERT INTO user_chat_sessions (user_id, sessions_json, updated_at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET sessions_json = excluded.sessions_json, updated_at = excluded.updated_at`,
      [userId, sessionsJson, ts],
    );
    return true;
  } catch (e) {
    console.warn("[db] saveUserChatSessions failed", e?.message || e);
    return false;
  }
}
