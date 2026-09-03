import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_PDF_META_FIELDS,
  parseServerPdfMetaJson,
  serverPdfMetaWindow,
} from "../serverPdfMetaExtract.js";

test("server PDF meta fields match the four requested columns", () => {
  assert.deepEqual(
    [...SERVER_PDF_META_FIELDS],
    ["symmetry_phase", "synthesis_method", "structure_descriptor", "properties"],
  );
});

test("meta window keeps short text unchanged", () => {
  const text = "A short abstract with enough material information.";
  assert.equal(serverPdfMetaWindow(text), text);
});

test("meta window returns head and tail for long text", () => {
  const text = "A".repeat(30_000);
  const out = serverPdfMetaWindow(text, { headChars: 1_000, tailChars: 500 });
  assert.ok(out.startsWith("A".repeat(1_000)));
  assert.ok(out.endsWith("A".repeat(500)));
  assert.match(out, /中间正文已省略/);
  assert.ok(out.length < text.length);
});

test("meta window avoids overlap duplication for mid-size text", () => {
  const text = "B".repeat(1_200);
  const out = serverPdfMetaWindow(text, { headChars: 1_000, tailChars: 500 });
  assert.equal(out, text);
});

test("meta window honors PDF_META_HEAD_CHARS env override", () => {
  const previous = process.env.PDF_META_HEAD_CHARS;
  process.env.PDF_META_HEAD_CHARS = "2000";
  try {
    const out = serverPdfMetaWindow("C".repeat(12_000));
    assert.ok(out.startsWith("C".repeat(2_000)));
  } finally {
    if (previous === undefined) delete process.env.PDF_META_HEAD_CHARS;
    else process.env.PDF_META_HEAD_CHARS = previous;
  }
});

test("meta JSON parse strips markdown fences", () => {
  const result = parseServerPdfMetaJson(
    '```json\n{"symmetry_phase":"立方相, cubic","synthesis_method":null,"structure_descriptor":"层状, layered","properties":"高导电, conductive"}\n```',
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.symmetry_phase, "立方相, cubic");
  assert.equal(result.data.synthesis_method, null);
  assert.equal(result.data.structure_descriptor, "层状, layered");
  assert.equal(result.data.properties, "高导电, conductive");
});

test("meta JSON parse handles trailing noise", () => {
  const result = parseServerPdfMetaJson(
    'Some preface text {"symmetry_phase":"单斜相"} trailing explanation',
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.symmetry_phase, "单斜相");
  assert.equal(result.data.synthesis_method, null);
});

test("meta JSON parse returns all nulls for invalid json", () => {
  const result = parseServerPdfMetaJson("this is not json at all");
  assert.equal(result.ok, false);
  assert.equal(result.error, "json_parse");
  assert.deepEqual(result.data, {
    symmetry_phase: null,
    synthesis_method: null,
    structure_descriptor: null,
    properties: null,
  });
});

test("meta JSON parse truncates long values and maps blanks to null", () => {
  const result = parseServerPdfMetaJson(
    JSON.stringify({
      symmetry_phase: "x".repeat(600),
      synthesis_method: "  sol-gel\n  sintering  ",
      structure_descriptor: "",
      properties: "   ",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.symmetry_phase.length, 500);
  assert.equal(result.data.synthesis_method, "sol-gel sintering");
  assert.equal(result.data.structure_descriptor, null);
  assert.equal(result.data.properties, null);
});
