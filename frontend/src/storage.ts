import type { ChatSession } from "./types";
import type { AppEdition } from "./edition";
import { getAppEdition } from "./edition";

/** Legacy key used when no userId is available (anonymous / pre-auth). */
const KEY = "paper-query-sessions-v1";
const MAX_SESSIONS = 30;

/**
 * Returns the localStorage key for the given user.
 * Authenticated users get an isolated v2 key; anonymous state falls back to
 * the legacy v1 key so existing anonymous sessions are not lost.
 */
export function getSessionKey(userId?: string | null, edition: AppEdition = getAppEdition()): string {
  if (userId && typeof userId === "string" && userId.trim().length > 0) {
    return `paper-query-sessions-v3:${edition}:${userId.trim()}`;
  }
  return `paper-query-sessions-v3:${edition}:anonymous`;
}

/**
 * Remove the v2 sessions key for a specific user.
 * Does NOT touch other users' keys or the anonymous v1 key.
 */
export function clearUserSessions(userId: string, edition: AppEdition = getAppEdition()): void {
  if (!userId || typeof userId !== "string") return;
  try {
    localStorage.removeItem(getSessionKey(userId, edition));
  } catch {
    /* ignore */
  }
}

/** 写入 localStorage 前精简体积（图表 PNG 等） */
export function slimSessionForStorage(s: ChatSession): ChatSession {
  return {
    ...s,
    messages: s.messages.map((m) => {
      if (m.role !== "assistant" || !m.meta) return m;
      const meta = { ...m.meta };
      if (meta.synthesis && meta.synthesis.length > 12_000) {
        meta.synthesis = meta.synthesis.slice(0, 12_000) + "\n\n…(内容过长已截断)";
      }
      if (meta.paperChart) {
        meta.paperChart = {
          ...meta.paperChart,
          pngBase64: null,
          spec: null,
          note: meta.paperChart.note || "图表数据已精简存储",
        };
      }
      return { ...m, meta };
    }),
  };
}

function trimSessions(sessions: ChatSession[]): ChatSession[] {
  if (sessions.length <= MAX_SESSIONS) return sessions;
  return sessions.slice(sessions.length - MAX_SESSIONS);
}

function progressiveTrim(sessions: ChatSession[]): ChatSession[] {
  let out = trimSessions(sessions.map(slimSessionForStorage));
  for (let pass = 0; pass < 4; pass++) {
    try {
      JSON.stringify(out);
      return out;
    } catch {
      out = out.map((s) => ({
        ...s,
        messages: s.messages.map((m) => {
          if (m.role !== "assistant" || !m.meta) return m;
          const meta = { ...m.meta };
          if (pass >= 0) {
            delete (meta as Record<string, unknown>).paperChart;
            delete (meta as Record<string, unknown>).dataTables;
          }
          if (pass >= 1) delete (meta as Record<string, unknown>).synthesis;
          if (pass >= 2) {
            delete (meta as Record<string, unknown>).webAnswerDrafts;
            delete (meta as Record<string, unknown>).deepSynthesis;
            delete (meta as Record<string, unknown>).deepMine;
          }
          if (pass >= 3) {
            return {
              ...m,
              meta: {
                effectiveQuery: meta.effectiveQuery,
                channel: meta.channel,
                synthesisNote: meta.synthesisNote,
              },
            };
          }
          return { ...m, meta };
        }),
      }));
      if (pass === 3) out = out.slice(-10);
    }
  }
  return out.slice(-5);
}

export function mergeChatSessions(local: ChatSession[], remote: ChatSession[]): ChatSession[] {
  const map = new Map<string, ChatSession>();
  for (const s of remote) {
    if (s?.id) map.set(s.id, s);
  }
  for (const s of local) {
    if (!s?.id) continue;
    const prev = map.get(s.id);
    if (!prev || (s.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
      map.set(s.id, s);
    }
  }
  return [...map.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function loadSessions(userId?: string | null, edition: AppEdition = getAppEdition()): ChatSession[] {
  try {
    const currentKey = getSessionKey(userId, edition);
    let raw = localStorage.getItem(currentKey);
    if (!raw && edition === "school") {
      const legacyKey = userId && userId.trim()
        ? `paper-query-sessions-v2:${userId.trim()}`
        : KEY;
      raw = localStorage.getItem(legacyKey);
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSessions(
  sessions: ChatSession[],
  userId?: string | null,
  edition: AppEdition = getAppEdition(),
) {
  const storageKey = getSessionKey(userId, edition);
  try {
    const trimmed = progressiveTrim(sessions);
    localStorage.setItem(storageKey, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("[storage] saveSessions failed:", e);
    try {
      const fallback = progressiveTrim(sessions).slice(-8);
      localStorage.setItem(storageKey, JSON.stringify(fallback));
    } catch (e2) {
      console.error("[storage] saveSessions fallback failed, 保留内存中的会话直至下次成功保存", e2);
    }
  }
}

export function sessionsPayloadForServer(sessions: ChatSession[]): ChatSession[] {
  return progressiveTrim(sessions);
}
