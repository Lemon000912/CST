import test from "node:test";
import assert from "node:assert/strict";
import { getPublicPatentSources } from "../mcpWebSearch.js";
test("专利仅开放 EPS，旧配置不能重新开启其他渠道", () => {
  const previous = process.env.PATENT_PUBLIC_SOURCES;
  try {
    for (const value of [undefined, "cnipa,uspto,espacenet", "jplatpat;cnipa unknown"]) {
      if (value === undefined) delete process.env.PATENT_PUBLIC_SOURCES;
      else process.env.PATENT_PUBLIC_SOURCES = value;
      assert.deepEqual(getPublicPatentSources().map(source => source.id), ["epo_publication_server"]);
    }
  } finally {
    if (previous === undefined) delete process.env.PATENT_PUBLIC_SOURCES;
    else process.env.PATENT_PUBLIC_SOURCES = previous;
  }
});
