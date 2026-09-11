import { getSqliteDb, pgPool, withDatabaseTransaction } from "./db.js";

export class AdminUsersError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AdminUsersError";
    this.status = status;
    this.code = code;
  }
}

async function getReadDb() {
  if (pgPool) {
    return {
      dialect: "postgres",
      get: async (sql, params = []) => {
        const result = await pgPool.query(sql, params);
        return result.rows[0] || null;
      },
      all: async (sql, params = []) => {
        const result = await pgPool.query(sql, params);
        return result.rows;
      },
    };
  }
  return getSqliteDb();
}

export async function listAdminUsers({ skip = 0, limit = 10, search = "", status = "" } = {}) {
  const normalizedSkip = Math.max(0, Number(skip) || 0);
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 10));
  const normalizedSearch = String(search || "").trim().slice(0, 100);
  const normalizedStatus = ["0", "1"].includes(String(status)) ? String(status) : "";
  const db = await getReadDb();
  const clauses = [];
  const params = [];

  if (normalizedStatus === "0") clauses.push("1 = 0");
  if (normalizedSearch) {
    if (db.dialect === "postgres") {
      params.push(`%${normalizedSearch}%`);
      clauses.push(`(
        u.username ILIKE $${params.length}
        OR COALESCE(u.email, '') ILIKE $${params.length}
        OR COALESCE(u.phone, '') ILIKE $${params.length}
      )`);
    } else {
      const pattern = `%${normalizedSearch.toLowerCase()}%`;
      params.push(pattern, pattern, pattern);
      clauses.push(`(
        LOWER(u.username) LIKE ?
        OR LOWER(COALESCE(u.email, '')) LIKE ?
        OR LOWER(COALESCE(u.phone, '')) LIKE ?
      )`);
    }
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const countRow = await db.get(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
  let rows;
  const listSql = `
    SELECT u.id, u.username, u.email, u.phone, u.created_at
    FROM users u
    ${whereSql}
    ORDER BY u.created_at DESC`;
  if (db.dialect === "postgres") {
    const listParams = [...params, normalizedLimit, normalizedSkip];
    rows = await db.all(
      `${listSql} LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
  } else {
    rows = await db.all(`${listSql} LIMIT ? OFFSET ?`, [...params, normalizedLimit, normalizedSkip]);
  }

  return {
    users: rows.map((row) => ({
      id: String(row.id),
      username: String(row.username),
      email: row.email ? String(row.email) : null,
      phone: row.phone ? String(row.phone) : null,
      created_at: Number(row.created_at),
      last_active: Number(row.created_at),
      is_active: true,
    })),
    total: Number(countRow?.total || 0),
  };
}

export async function deleteAdminUser({ userId, adminUserId } = {}) {
  const normalizedUserId = String(userId || "").trim().slice(0, 128);
  const normalizedAdminUserId = String(adminUserId || "").trim().slice(0, 128);
  if (!normalizedUserId) {
    throw new AdminUsersError(400, "missing-user-id", "缺少用户 ID");
  }
  if (normalizedUserId === normalizedAdminUserId) {
    throw new AdminUsersError(400, "cannot-delete-current-admin", "不能删除当前登录的管理员账号");
  }

  return withDatabaseTransaction(async (tx) => {
    const user = await tx.get(
      tx.dialect === "postgres"
        ? "SELECT id, username FROM users WHERE id = $1 FOR UPDATE"
        : "SELECT id, username FROM users WHERE id = ?",
      [normalizedUserId],
    );
    if (!user) {
      throw new AdminUsersError(404, "user-not-found", "用户不存在");
    }

    const operationRows = await tx.all(
      tx.dialect === "postgres"
        ? "SELECT id FROM point_operations WHERE user_id = $1"
        : "SELECT id FROM point_operations WHERE user_id = ?",
      [normalizedUserId],
    );
    const operationIds = operationRows.map((row) => String(row.id));

    const userDataTables = [
      "user_wechat_identities",
      "user_student_verifications",
      "user_preferences",
      "user_skill",
      "user_downloaded_paper",
      "user_answer_feedback",
      "user_chat_sessions_by_edition",
      "user_chat_sessions",
      "query_log",
      "feedback",
      "pdf_download_log",
    ];

    for (const tableName of userDataTables) {
      if (!(await tableExists(tx, tableName))) continue;
      await deleteRowsForUser(tx, tableName, normalizedUserId);
    }

    if (tx.dialect === "postgres") {
      await tx.run("SELECT set_config('quantum_pinnacle.allow_user_purge', 'on', true)");
    } else {
      await tx.run("DROP TRIGGER IF EXISTS point_ledger_no_delete");
    }

    await deleteRowsForUser(tx, "point_ledger", normalizedUserId);

    if (tx.dialect === "sqlite") {
      await tx.run(`
        CREATE TRIGGER point_ledger_no_delete
        BEFORE DELETE ON point_ledger
        BEGIN SELECT RAISE(ABORT, 'point_ledger is immutable'); END
      `);
    }

    for (const tableName of ["point_operations", "point_recharge_orders", "point_wallets"]) {
      await deleteRowsForUser(tx, tableName, normalizedUserId);
    }

    await tx.run(
      tx.dialect === "postgres"
        ? "DELETE FROM users WHERE id = $1"
        : "DELETE FROM users WHERE id = ?",
      [normalizedUserId],
    );

    return {
      id: String(user.id),
      username: String(user.username),
      deleted: true,
      operationIds,
    };
  });
}

async function tableExists(tx, tableName) {
  if (tx.dialect === "postgres") {
    const row = await tx.get(
      `SELECT 1 AS present
       FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1`,
      [tableName],
    );
    return Boolean(row);
  }
  const row = await tx.get(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  );
  return Boolean(row);
}

function deleteRowsForUser(tx, tableName, userId) {
  const placeholder = tx.dialect === "postgres" ? "$1" : "?";
  return tx.run(`DELETE FROM ${tableName} WHERE user_id = ${placeholder}`, [userId]);
}
