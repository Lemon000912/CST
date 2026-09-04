export type AppEdition = "school" | "enterprise";

export const APP_EDITION: AppEdition = import.meta.env.VITE_APP_EDITION === "enterprise"
  ? "enterprise"
  : "school";

export function getAppEdition(): AppEdition {
  return APP_EDITION;
}
