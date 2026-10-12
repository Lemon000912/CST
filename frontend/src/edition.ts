export type AppEdition = "school" | "enterprise" | "finance";

const rawEdition = String(import.meta.env.VITE_APP_EDITION ?? "").trim().toLowerCase();
export const APP_EDITION: AppEdition = rawEdition === "enterprise"
  ? "enterprise"
  : rawEdition === "finance"
    ? "finance"
    : "school";

export function getAppEdition(): AppEdition {
  return APP_EDITION;
}
