export const APP_EDITIONS = Object.freeze(["school", "enterprise"]);

export function normalizeAppEdition(value) {
  return String(value ?? "").trim().toLowerCase() === "enterprise"
    ? "enterprise"
    : "school";
}

export function getConfiguredAppEdition(env = process.env) {
  return normalizeAppEdition(env?.APP_EDITION);
}

export function isEnterpriseAppEdition(edition) {
  return normalizeAppEdition(edition) === "enterprise";
}
