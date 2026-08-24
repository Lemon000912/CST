export type AppEdition = "school" | "enterprise";

const EDITION_KEY = "paper-query-app-edition-v1";

export function getAppEdition(): AppEdition {
  try {
    return localStorage.getItem(EDITION_KEY) === "enterprise" ? "enterprise" : "school";
  } catch {
    return "school";
  }
}

export function setAppEdition(edition: AppEdition): void {
  try {
    localStorage.setItem(EDITION_KEY, edition);
  } catch {
    /* ignore */
  }
}

export function appEditionHeader(): Record<string, string> {
  return { "X-App-Edition": getAppEdition() };
}
