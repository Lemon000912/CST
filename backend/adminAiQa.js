import { formatPointUnits } from "./billing.js";
import { getSqliteDb, pgPool } from "./db.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class AdminAiQaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AdminAiQaError";
    this.status = status;
    this.code = code;
  }
}

function safeInteger(value, field, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new AdminAiQaError(500, "invalid-ai-qa-data", `${field} 超出安全范围`);
  }
  return number;
}

function normalizeTimestamp(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new AdminAiQaError(400, "invalid-date-filter", `${field}无效`);
  }
  return number;
}

function normalizeFilters({ search = "", status = "", from = null, to = null } = {}) {
  const normalizedStatus = ["success", "stopped"].includes(status) ? status : "";
  const normalizedFrom = normalizeTimestamp(from, "开始日期");
  const normalizedTo = normalizeTimestamp(to, "结束日期");
  if (normalizedFrom !== null && normalizedTo !== null && normalizedFrom > normalizedTo) {
    throw new AdminAiQaError(400, "invalid-date-range", "开始日期不能晚于结束日期");
  }
  return {
    search: String(search || "").trim().slice(0, 200),
    status: normalizedStatus,
    from: normalizedFrom,
    to: normalizedTo,
  };
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

function jsonExpressions(dialect) {
  if (dialect === "postgres") {
    return {
      version: "o.result_json::jsonb #>> '{adminQa,version}'",
      question: "o.result_json::jsonb #>> '{adminQa,question}'",
      answer: "o.result_json::jsonb ->> 'synthesis'",
      deepAnswer: "o.result_json::jsonb ->> 'deepSynthesis'",
      paused: "COALESCE(o.result_json::jsonb ->> 'paused', 'false') = 'true'",
      channel: "o.result_json::jsonb ->> 'channel'",
      edition: "o.billing_details_json::jsonb ->> 'edition'",
    };
  }
  return {
    version: "json_extract(o.result_json, '$.adminQa.version')",
    question: "json_extract(o.result_json, '$.adminQa.question')",
    answer: "json_extract(o.result_json, '$.synthesis')",
    deepAnswer: "json_extract(o.result_json, '$.deepSynthesis')",
    paused: "COALESCE(json_extract(o.result_json, '$.paused'), 0) = 1",
    channel: "json_extract(o.result_json, '$.channel')",
    edition: "json_extract(o.billing_details_json, '$.edition')",
  };
}

function buildWhere(db, filters) {
  const json = jsonExpressions(db.dialect);
  const params = [];
  const bind = (value) => {
    params.push(value);
    return db.dialect === "postgres" ? `$${params.length}` : "?";
  };
  const clauses = [
    "o.operation_type = 'search'",
    "o.status = 'completed'",
    "o.cost_units > 0",
    "o.result_json IS NOT NULL",
    db.dialect === "postgres"
      ? `COALESCE(${json.version}, '') = '1'`
      : `CAST(COALESCE(${json.version}, 0) AS INTEGER) = 1`,
  ];

  if (filters.search) {
    const term = `%${filters.search}%`;
    if (db.dialect === "postgres") {
      const placeholder = bind(term);
      clauses.push(`(u.username ILIKE ${placeholder} OR u.id ILIKE ${placeholder} OR o.id ILIKE ${placeholder} OR COALESCE(${json.question}, '') ILIKE ${placeholder})`);
    } else {
      const lowerTerm = term.toLowerCase();
      clauses.push(`(LOWER(u.username) LIKE ${bind(lowerTerm)} OR LOWER(u.id) LIKE ${bind(lowerTerm)} OR LOWER(o.id) LIKE ${bind(lowerTerm)} OR LOWER(COALESCE(${json.question}, '')) LIKE ${bind(lowerTerm)})`);
    }
  }
  if (filters.status === "stopped") clauses.push(json.paused);
  if (filters.status === "success") clauses.push(`NOT (${json.paused})`);
  if (filters.from !== null) clauses.push(`o.completed_at >= ${bind(filters.from)}`);
  if (filters.to !== null) clauses.push(`o.completed_at <= ${bind(filters.to)}`);

  return { whereSql: clauses.join(" AND "), params, json };
}

function ledgerJoinSql() {
  return `LEFT JOIN point_ledger l ON l.id = (
    SELECT li.id FROM point_ledger li
    WHERE li.operation_id = o.id AND li.entry_type = 'debit'
    ORDER BY li.created_at DESC LIMIT 1
  )`;
}

function publicListRecord(row) {
  const costUnits = safeInteger(row.cost_units, "消耗积分");
  return {
    id: String(row.operation_id),
    operationId: String(row.operation_id),
    userId: String(row.user_id),
    username: String(row.username || "-"),
    question: String(row.question || ""),
    answerPreview: String(row.answer_preview || ""),
    deepAnswerPreview: String(row.deep_answer_preview || ""),
    status: row.is_paused ? "stopped" : "success",
    costUnits,
    cost: formatPointUnits(costUnits),
    ledgerId: row.ledger_id ? String(row.ledger_id) : null,
    balanceAfterUnits: safeInteger(row.balance_after_units, "变动后余额", { nullable: true }),
    balanceAfter: row.balance_after_units === null || row.balance_after_units === undefined
      ? null
      : formatPointUnits(safeInteger(row.balance_after_units, "变动后余额")),
    createdAt: safeInteger(row.created_at, "创建时间"),
    completedAt: safeInteger(row.completed_at, "完成时间"),
  };
}

function publicDetailRecord(row) {
  return {
    ...publicListRecord({
      ...row,
      answer_preview: row.answer,
      deep_answer_preview: row.deep_answer,
    }),
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    answer: String(row.answer || ""),
    deepAnswer: String(row.deep_answer || ""),
    channel: String(row.channel || ""),
    edition: String(row.edition || ""),
    ledgerCreatedAt: safeInteger(row.ledger_created_at, "流水时间", { nullable: true }),
  };
}

export async function listAdminAiQaRecords({ skip = 0, limit = DEFAULT_PAGE_SIZE, ...rawFilters } = {}) {
  const normalizedSkip = Math.max(0, Number(skip) || 0);
  const normalizedLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE));
  const filters = normalizeFilters(rawFilters);
  const db = await getReadDb();
  const { whereSql, params, json } = buildWhere(db, filters);
  const countRow = await db.get(
    `SELECT COUNT(*) AS total
     FROM point_operations o JOIN users u ON u.id = o.user_id
     WHERE ${whereSql}`,
    params,
  );

  const questionPreview = db.dialect === "postgres"
    ? `SUBSTRING(COALESCE(${json.question}, '') FROM 1 FOR 500)`
    : `substr(COALESCE(${json.question}, ''), 1, 500)`;
  const answerPreview = db.dialect === "postgres"
    ? `SUBSTRING(COALESCE(${json.answer}, '') FROM 1 FOR 500)`
    : `substr(COALESCE(${json.answer}, ''), 1, 500)`;
  const deepAnswerPreview = db.dialect === "postgres"
    ? `SUBSTRING(COALESCE(${json.deepAnswer}, '') FROM 1 FOR 500)`
    : `substr(COALESCE(${json.deepAnswer}, ''), 1, 500)`;
  const pageParams = [...params, normalizedLimit, normalizedSkip];
  const limitSql = db.dialect === "postgres"
    ? `LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`
    : "LIMIT ? OFFSET ?";
  const rows = await db.all(
    `SELECT o.id AS operation_id, o.user_id, u.username, o.cost_units,
            o.created_at, o.completed_at, l.id AS ledger_id, l.balance_after_units,
            ${questionPreview} AS question,
            ${answerPreview} AS answer_preview,
            ${deepAnswerPreview} AS deep_answer_preview,
            CASE WHEN ${json.paused} THEN 1 ELSE 0 END AS is_paused
     FROM point_operations o
     JOIN users u ON u.id = o.user_id
     ${ledgerJoinSql()}
     WHERE ${whereSql}
     ORDER BY o.completed_at DESC, o.id DESC
     ${limitSql}`,
    pageParams,
  );
  return { records: rows.map(publicListRecord), total: Number(countRow?.total || 0) };
}

export async function getAdminAiQaRecord(operationId) {
  const normalizedId = String(operationId || "").trim().slice(0, 128);
  if (!normalizedId) throw new AdminAiQaError(400, "missing-operation-id", "缺少计费操作 ID");
  const db = await getReadDb();
  const json = jsonExpressions(db.dialect);
  const placeholder = db.dialect === "postgres" ? "$1" : "?";
  const versionCheck = db.dialect === "postgres"
    ? `COALESCE(${json.version}, '') = '1'`
    : `CAST(COALESCE(${json.version}, 0) AS INTEGER) = 1`;
  const row = await db.get(
    `SELECT o.id AS operation_id, o.user_id, u.username, u.email, u.phone,
            o.cost_units, o.created_at, o.completed_at,
            l.id AS ledger_id, l.balance_after_units, l.created_at AS ledger_created_at,
            ${json.question} AS question, ${json.answer} AS answer,
            ${json.deepAnswer} AS deep_answer, ${json.channel} AS channel,
            ${json.edition} AS edition,
            CASE WHEN ${json.paused} THEN 1 ELSE 0 END AS is_paused
     FROM point_operations o
     JOIN users u ON u.id = o.user_id
     ${ledgerJoinSql()}
     WHERE o.id = ${placeholder} AND o.operation_type = 'search'
       AND o.status = 'completed' AND o.cost_units > 0
       AND o.result_json IS NOT NULL AND ${versionCheck}`,
    [normalizedId],
  );
  if (!row) throw new AdminAiQaError(404, "ai-qa-record-not-found", "AI 问答记录不存在");
  return publicDetailRecord(row);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvDate(value) {
  if (!value) return "";
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export async function exportAdminAiQaRecords(rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  const db = await getReadDb();
  const { whereSql, params, json } = buildWhere(db, filters);
  const rows = await db.all(
    `SELECT o.id AS operation_id, o.user_id, u.username, o.cost_units,
            o.created_at, o.completed_at, l.id AS ledger_id, l.balance_after_units,
            ${json.question} AS question, ${json.answer} AS answer,
            ${json.deepAnswer} AS deep_answer,
            CASE WHEN ${json.paused} THEN 1 ELSE 0 END AS is_paused
     FROM point_operations o
     JOIN users u ON u.id = o.user_id
     ${ledgerJoinSql()}
     WHERE ${whereSql}
     ORDER BY o.completed_at DESC, o.id DESC`,
    params,
  );
  const header = ["用户名", "用户ID", "用户问题", "AI回答", "深度研究回答", "状态", "消耗积分", "计费操作ID", "积分流水ID", "提交时间", "完成时间", "变动后余额"];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const costUnits = safeInteger(row.cost_units, "消耗积分");
    const balanceAfter = row.balance_after_units === null || row.balance_after_units === undefined
      ? ""
      : formatPointUnits(safeInteger(row.balance_after_units, "变动后余额"));
    lines.push([
      row.username,
      row.user_id,
      row.question,
      row.answer,
      row.deep_answer,
      row.is_paused ? "已停止" : "成功",
      formatPointUnits(costUnits),
      row.operation_id,
      row.ledger_id,
      csvDate(row.created_at),
      csvDate(row.completed_at),
      balanceAfter,
    ].map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}`;
}
