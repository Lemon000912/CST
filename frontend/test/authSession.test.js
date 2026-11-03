import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("same-origin edition sessions do not share tokens, profiles or logout", () => {
  const values = new Map([["paper-query-jwt-v1", "old-unscoped-token"]]);
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const source = fs.readFileSync(new URL("../src/authSession.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sessions = {};
  for (const edition of ["school", "enterprise", "finance"]) {
    const exports = {};
    vm.runInNewContext(js, {
      exports, localStorage,
      require: name => {
        if (name === "./edition") return { APP_EDITION: edition };
        if (name === "./userId") return { getUserId: () => "anonymous-device" };
        throw new Error(`Unexpected dependency ${name}`);
      },
    });
    sessions[edition] = exports;
    assert.equal(exports.getAuthToken(), null);
    assert.equal(exports.getAuthProfile(), null);
    exports.setAuthSession(`${edition}-token`, { userId: `${edition}-user`, username: "same_name" });
  }
  for (const [edition, session] of Object.entries(sessions)) {
    assert.equal(session.getAuthToken(), `${edition}-token`);
    assert.equal(session.getEffectiveUserId(), `${edition}-user`);
  }
  sessions.school.clearAuthSession();
  assert.equal(sessions.school.getAuthToken(), null);
  assert.equal(sessions.enterprise.getAuthToken(), "enterprise-token");
  assert.equal(sessions.finance.getAuthToken(), "finance-token");
});
