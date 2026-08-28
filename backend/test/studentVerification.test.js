import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sqliteFile = path.join(os.tmpdir(), `quantum-pinnacle-student-verification-${process.pid}-${crypto.randomUUID()}.sqlite`);
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.USE_POSTGRES = "false";
process.env.SQLITE_FILE = sqliteFile;
process.env.NODE_ENV = "test";

const {
  createUserRecord,
  getSqliteDb,
  getStudentVerification,
  grantStudentVerification,
  initDatabase,
} = await import("../db.js");
const { isStudentCardAccepted, parseStudentCardDecision } = await import("../studentVerification.js");

test("student card decisions require confidence, school and an identity field", () => {
  const valid = parseStudentCardDecision('```json\n{"is_student_card":true,"confidence":0.92,"school":"测试大学","student_id":"20260001","reason":"清晰"}\n```');
  assert.equal(isStudentCardAccepted(valid), true);
  assert.equal(isStudentCardAccepted({ ...valid, confidence: 0.74 }), false);
  assert.equal(isStudentCardAccepted({ ...valid, school: "" }), false);
  assert.equal(isStudentCardAccepted({ ...valid, studentId: "", name: "" }), false);
  assert.equal(parseStudentCardDecision("not json"), null);
});

test("student verification grants exactly 1000 points once", async (t) => {
  t.after(() => {
    try { fs.rmSync(sqliteFile, { force: true }); } catch { /* sql.js lock exits with worker */ }
  });
  await initDatabase();
  const userId = "student-verification-user";
  await createUserRecord(userId, "student_verification_user", "unused");
  const first = await grantStudentVerification({
    userId,
    confidence: 0.96,
    model: "model-a",
    documentHash: "a".repeat(64),
    details: { school: "测试大学", imageSha256: "abc" },
  });
  assert.equal(first.rewarded, true);
  assert.equal(first.balanceUnits, 40_000);
  const second = await grantStudentVerification({
    userId,
    confidence: 0.99,
    model: "model-a",
    documentHash: "a".repeat(64),
    details: { school: "测试大学", imageSha256: "def" },
  });
  assert.equal(second.rewarded, false);
  assert.equal(second.balanceUnits, 40_000);
  const verification = await getStudentVerification(userId);
  assert.equal(verification.verified, true);
  assert.equal(verification.details.school, "测试大学");
  const db = await getSqliteDb();
  const rows = await db.all("SELECT * FROM point_ledger WHERE user_id = ? AND entry_type = 'student_verification_grant'", [userId]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].delta_units), 20_000);

  const otherUserId = "student-verification-user-2";
  await createUserRecord(otherUserId, "student_verification_user_2", "unused");
  await assert.rejects(
    grantStudentVerification({
      userId: otherUserId,
      confidence: 0.97,
      model: "model-a",
      documentHash: "a".repeat(64),
      details: { school: "测试大学" },
    }),
    (error) => error?.code === "student-card-already-used" && error?.status === 409,
  );
});
