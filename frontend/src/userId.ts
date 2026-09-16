const KEY = "paper-query-user-id-v1";
import { createUuid } from "./uuid";

export function getUserId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = createUuid();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}
