import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const source = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let result;
  function visit(node) {
    if (predicate(node)) result = node;
    else ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(result, "application implementation exists");
  return result;
}
function compile(text) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
}
const cardNode = find(node => ts.isFunctionDeclaration(node) && node.name?.text === "PaperCard");
const PaperCard = vm.runInNewContext(compile(cardNode.getText(tree)) + "\nPaperCard;", {
  React, useState: React.useState, normalizeDoiField: () => "",
});
const paper = { id: "paper-1", title: "Paper", summary: "Abstract", authors: [], pdfUrl: "/paper.pdf" };
function card(props = {}) {
  return renderToStaticMarkup(React.createElement(PaperCard, {
    p: paper, open: true, onOpenChange() {}, ...props,
  }));
}

test("PDF controls distinguish normal, current request, another request, and exhausted balance", () => {
  const idle = card();
  assert.match(idle, /成功后收费 1 积分/);
  assert.doesNotMatch(idle, /disabled=""/);
  const current = card({ pdfBusy: "current" });
  assert.match(current, /正在验证并获取 PDF，请稍候/);
  assert.match(current, /获取中…/);
  assert.match(current, /aria-busy="true"/);
  assert.match(current, /disabled:cursor-wait/);
  assert.doesNotMatch(current, /积分不足|积分已用完/);
  const other = card({ pdfBusy: "other" });
  assert.match(other, /另一份 PDF 正在获取，请稍候/);
  assert.match(other, /disabled=""/);
  assert.doesNotMatch(other, /积分不足|获取中…/);
  const exhausted = card({ billingDisabled: true });
  assert.match(exhausted, /积分不足，暂不能获取 PDF/);
  assert.match(exhausted, /disabled=""/);
});

const handlerNode = find(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === "handlePdfFulfill");
function handler(overrides = {}) {
  const events = [];
  const context = {
    Error, ApiError: class ApiError extends Error {},
    pointsEnabled: true, pointBalance: { balance: 10 },
    pdfRequestInFlight: { current: false }, paperRowKey: p => p.id,
    createIdempotencyKey: () => "test-key",
    setPdfBusyKey: key => events.push(["busy", key]),
    fulfillPdf: async () => ({ blob: {}, filename: "paper.pdf" }),
    applyReceipt() {}, fetchPointBalance: async () => ({ billing: { balance: 9 } }),
    setPointBalance() {}, setBalanceError() {}, patchMessageMeta() {},
    saveAs: () => events.push(["saved"]),
    formatPoints: String, window: { alert: message => events.push(["alert", message]) },
    ...overrides,
  };
  const run = vm.runInNewContext(compile("const run = " + handlerNode.initializer.arguments[0].getText(tree)) + "\nrun;", context);
  return { run, context, events };
}
const message = { id: "message-1", meta: { parentOperationId: "search-1" } };

test("rapid PDF clicks send one request; failure releases the lock for retry", async () => {
  let rejectRequest;
  let calls = 0;
  const h = handler({ fulfillPdf: () => {
    calls += 1;
    return new Promise((_, reject) => { rejectRequest = reject; });
  } });
  const first = h.run(message, paper, "save");
  await h.run(message, { ...paper, id: "paper-2" }, "save");
  assert.equal(calls, 1);
  rejectRequest(new Error("PDF source unavailable"));
  await first;
  assert.equal(h.context.pdfRequestInFlight.current, false);
  assert.deepEqual(h.events.at(-1), ["busy", null]);
  assert.ok(h.events.some(event => event[1] === "PDF source unavailable"));
  h.context.fulfillPdf = async () => { calls += 1; return { blob: {}, filename: "paper.pdf" }; };
  await h.run(message, paper, "save");
  assert.equal(calls, 2);
  assert.ok(h.events.some(event => event[0] === "saved"));
  assert.equal(h.context.pdfRequestInFlight.current, false);
});

test("an exhausted balance prevents a PDF request", async () => {
  let calls = 0;
  const h = handler({ pointBalance: { balance: 0 }, fulfillPdf: async () => { calls += 1; } });
  await h.run(message, paper, "save");
  assert.equal(calls, 0);
  assert.ok(h.events.some(event => event[0] === "alert" && event[1].includes("积分已用完")));
  assert.equal(h.context.pdfRequestInFlight.current, false);
});
