import test from "node:test";
import assert from "node:assert/strict";

import { buildWebPatentSearchQuery } from "../searchService.js";

test("patent search query preserves the original Chinese technical question", () => {
  const rawQuery = "对用的挤压工艺会有侧向剪切力，怀疑剪切力不当导致纤维断裂";
  const patentQuery = buildWebPatentSearchQuery(rawQuery, "fiber");

  assert.match(patentQuery, /fiber/);
  assert.match(patentQuery, /挤压工艺/);
  assert.match(patentQuery, /侧向剪切力/);
  assert.match(patentQuery, /纤维断裂/);
});
