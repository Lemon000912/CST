import test from "node:test";
import assert from "node:assert/strict";

import {
  getConfiguredAppEdition,
  isBusinessAppEdition,
  isEnterpriseAppEdition,
  normalizeAppEdition,
} from "../appEdition.js";

test("application edition is fixed from server configuration", () => {
  assert.equal(normalizeAppEdition("enterprise"), "enterprise");
  assert.equal(normalizeAppEdition(" ENTERPRISE "), "enterprise");
  assert.equal(normalizeAppEdition("school"), "school");
  assert.equal(normalizeAppEdition("unexpected"), "school");
  assert.equal(getConfiguredAppEdition({ APP_EDITION: "enterprise" }), "enterprise");
  assert.equal(isEnterpriseAppEdition("enterprise"), true);
  assert.equal(isEnterpriseAppEdition("school"), false);
  assert.equal(normalizeAppEdition("finance"), "finance");
  assert.equal(normalizeAppEdition("数智通 金融"), "finance");
  assert.equal(getConfiguredAppEdition({ APP_EDITION: "finance" }), "finance");
  assert.equal(isBusinessAppEdition("finance"), true);
});
