import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-admin-ai-qa-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const { createUserRecord, initDatabase } = await import("../db.js");
const { completeImmediateBillableOperation, stableRequestHash } = await import("../billing.js");
const {
  exportAdminAiQaRecords,
  getAdminAiQaRecord,
  listAdminAiQaRecords,
} = await import("../adminAiQa.js");

async function completeOperation({ userId, key, type = "search", edition = "school", costUnits, result }) {
  return completeImmediateBillableOperation({
    userId,
    operationType: type,
    idempotencyKey: key,
    requestHash: stableRequestHash({ key, type }),
    costUnits,
    billingDetails: { edition, characterCount: costUnits },
    result,
  });
}

test("AI QA admin records include only new charged search operations", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });
  await initDatabase();
  const userId = "admin-ai-qa-user";
  await createUserRecord(userId, "qa_auditor", "not-used-in-this-test");

  const success = await completeOperation({
    userId,
    key: "qa-success-0001",
    costUnits: 20,
    result: {
      synthesis: "普通完整回答",
      deepSynthesis: "深度研究回答",
      channel: "web",
      adminQa: { version: 1, question: "如何制备这种材料？" },
    },
  });
  await completeOperation({
    userId,
    key: "qa-stopped-0001",
    costUnits: 5,
    result: {
      synthesis: "用户停止前生成的部分回答",
      paused: true,
      channel: "database",
      adminQa: { version: 1, question: "给我一个实验方案" },
    },
  });
  const enterprise = await completeOperation({
    userId,
    key: "qa-enterprise-0001",
    edition: "enterprise",
    costUnits: 8,
    result: {
      synthesis: "企业版回答",
      channel: "web",
      adminQa: { version: 1, question: "企业版问题" },
    },
  });
  const finance = await completeOperation({
    userId,
    key: "qa-finance-0001",
    edition: "finance",
    costUnits: 9,
    result: {
      synthesis: "金融版回答",
      channel: "web",
      adminQa: { version: 1, question: "金融版问题" },
    },
  });
  await completeOperation({
    userId,
    key: "qa-zero-0001",
    costUnits: 0,
    result: {
      synthesis: "未产生积分消耗",
      adminQa: { version: 1, question: "不应显示" },
    },
  });
  await completeOperation({
    userId,
    key: "qa-historical-0001",
    costUnits: 10,
    result: { synthesis: "上线前历史回答" },
  });
  await completeOperation({
    userId,
    key: "qa-chart-0001",
    type: "chart",
    costUnits: 10,
    result: {
      synthesis: "图表操作",
      adminQa: { version: 1, question: "不应作为问答显示" },
    },
  });

  const listed = await listAdminAiQaRecords({ limit: 20 });
  assert.equal(listed.total, 4);
  assert.deepEqual(new Set(listed.records.map((record) => record.question)), new Set([
    "如何制备这种材料？",
    "给我一个实验方案",
    "企业版问题",
    "金融版问题",
  ]));
  assert.ok(listed.records.every((record) => record.costUnits > 0));
  assert.ok(listed.records.every((record) => record.ledgerId));
  assert.equal(listed.records.find((record) => record.operationId === enterprise.operation.id).edition, "enterprise");
  assert.equal(listed.records.find((record) => record.operationId === finance.operation.id).editionLabel, "金融版");

  const enterpriseRecords = await listAdminAiQaRecords({ edition: "enterprise" });
  assert.equal(enterpriseRecords.total, 1);
  assert.equal(enterpriseRecords.records[0].question, "企业版问题");
  assert.ok(enterpriseRecords.records.every((record) => record.edition === "enterprise"));
  const financeRecords = await listAdminAiQaRecords({ edition: "finance" });
  assert.equal(financeRecords.total, 1);
  assert.equal(financeRecords.records[0].question, "金融版问题");
  assert.ok(financeRecords.records.every((record) => record.edition === "finance"));

  const stopped = await listAdminAiQaRecords({ status: "stopped" });
  assert.equal(stopped.total, 1);
  assert.equal(stopped.records[0].status, "stopped");
  assert.equal(stopped.records[0].answerPreview, "用户停止前生成的部分回答");

  const searched = await listAdminAiQaRecords({ search: "制备" });
  assert.equal(searched.total, 1);
  assert.equal(searched.records[0].operationId, success.operation.id);

  const detail = await getAdminAiQaRecord(success.operation.id);
  assert.equal(detail.username, "qa_auditor");
  assert.equal(detail.answer, "普通完整回答");
  assert.equal(detail.deepAnswer, "深度研究回答");
  assert.equal(detail.cost, "1.00");
  assert.ok(detail.ledgerId);
  const enterpriseDetail = await getAdminAiQaRecord(enterprise.operation.id);
  assert.equal(enterpriseDetail.edition, "enterprise");
  assert.equal(enterpriseDetail.editionLabel, "企业版");

  const csv = await exportAdminAiQaRecords({ search: "实验方案" });
  assert.match(csv, /^\uFEFF/);
  assert.match(csv, /版本/);
  assert.match(csv, /给我一个实验方案/);
  assert.match(csv, /用户停止前生成的部分回答/);
  assert.doesNotMatch(csv, /上线前历史回答/);
});
