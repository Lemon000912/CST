import test from "node:test";
import assert from "node:assert/strict";

import { getPublicPatentSources } from "../mcpWebSearch.js";

test("public patent sources default to CNIPA, USPTO, and Espacenet", () => {
  const previous = process.env.PATENT_PUBLIC_SOURCES;
  delete process.env.PATENT_PUBLIC_SOURCES;
  try {
    assert.deepEqual(getPublicPatentSources().map((source) => source.id), ["cnipa", "uspto", "espacenet"]);
  } finally {
    if (previous === undefined) delete process.env.PATENT_PUBLIC_SOURCES;
    else process.env.PATENT_PUBLIC_SOURCES = previous;
  }
});

test("public patent sources accept a filtered list and ignore unknown and duplicate IDs", () => {
  const previous = process.env.PATENT_PUBLIC_SOURCES;
  process.env.PATENT_PUBLIC_SOURCES = "jplatpat;cnipa unknown cnipa";
  try {
    assert.deepEqual(getPublicPatentSources().map((source) => source.id), ["jplatpat", "cnipa"]);
  } finally {
    if (previous === undefined) delete process.env.PATENT_PUBLIC_SOURCES;
    else process.env.PATENT_PUBLIC_SOURCES = previous;
  }
});
