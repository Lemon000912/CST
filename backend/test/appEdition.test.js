import test from "node:test";
import assert from "node:assert/strict";

import {
  getConfiguredAppEdition,
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
});
