export const APP_EDITIONS = Object.freeze(["school", "enterprise", "finance"]);

export function normalizeAppEdition(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "enterprise") return "enterprise";
  if (["finance", "financial", "数智通金融", "数智通 金融"].includes(normalized)) return "finance";
  return "school";
}

export function getConfiguredAppEdition(env = process.env) {
  return normalizeAppEdition(env?.APP_EDITION);
}

export function isEnterpriseAppEdition(edition) {
  return normalizeAppEdition(edition) === "enterprise";
}

export function isFinanceAppEdition(edition) {
  return normalizeAppEdition(edition) === "finance";
}

export function isBusinessAppEdition(edition) {
  const normalized = normalizeAppEdition(edition);
  return normalized === "enterprise" || normalized === "finance";
}
