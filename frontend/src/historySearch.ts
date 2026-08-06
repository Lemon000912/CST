import type { ChatMessage, ChatSession } from "./types";

export type HistorySearchHit = {
  sessionId: string;
  sessionTitle: string;
  messageId: string | null;
  role: "session" | "user" | "assistant";
  snippet: string;
  matchLabel: string;
  updatedAt: number;
  score: number;
};

function norm(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(text: string, query: string, max = 140): string {
  const t = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const q = norm(query);
  if (!q) return t.length > max ? `${t.slice(0, max)}…` : t;
  const idx = t.toLowerCase().indexOf(q);
  if (idx < 0) return t.length > max ? `${t.slice(0, max)}…` : t;
  const start = Math.max(0, idx - 36);
  const slice = t.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${slice}${start + max < t.length ? "…" : ""}`;
}

function messageSearchText(m: ChatMessage): string {
  const parts = [m.content];
  if (m.role === "assistant") {
    if (m.meta?.synthesis) parts.push(m.meta.synthesis);
    if (m.meta?.effectiveQuery) parts.push(m.meta.effectiveQuery);
    if (m.meta?.deepSynthesis) parts.push(m.meta.deepSynthesis);
  }
  return parts.filter(Boolean).join("\n");
}

function scoreMatch(hay: string, query: string, weight: number): number {
  const h = norm(hay);
  const q = norm(query);
  if (!q) return weight * 0.2;
  if (!h) return 0;
  if (h === q) return weight * 3;
  if (h.startsWith(q)) return weight * 2.2;
  if (h.includes(q)) return weight * 1.5;
  const tokens = q.split(" ").filter((t) => t.length >= 2);
  if (!tokens.length) return 0;
  let hit = 0;
  for (const t of tokens) {
    if (h.includes(t)) hit += 1;
  }
  return hit > 0 ? weight * (0.4 + (hit / tokens.length) * 0.9) : 0;
}

function formatWhen(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/**
 * 在本机已保存的会话中搜索标题与消息正文。
 */
export function searchChatHistory(
  sessions: ChatSession[],
  query: string,
  limit = 40,
): HistorySearchHit[] {
  const q = norm(query);
  const hits: HistorySearchHit[] = [];
  const seen = new Set<string>();

  const push = (hit: HistorySearchHit) => {
    const key = `${hit.sessionId}:${hit.messageId ?? "session"}:${hit.matchLabel}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  const ordered = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  for (const s of ordered) {
    const title = s.title?.trim() || "新对话";
    const titleScore = scoreMatch(title, q, 120);
    if (!q || titleScore > 0) {
      push({
        sessionId: s.id,
        sessionTitle: title,
        messageId: null,
        role: "session",
        snippet: excerpt(title, q, 80) || title,
        matchLabel: "对话标题",
        updatedAt: s.updatedAt ?? 0,
        score: titleScore + (q ? 0 : 50),
      });
    }

    for (const m of s.messages) {
      const text = messageSearchText(m);
      const bodyScore = scoreMatch(text, q, m.role === "user" ? 100 : 85);
      if (q && bodyScore <= 0) continue;
      push({
        sessionId: s.id,
        sessionTitle: title,
        messageId: m.id,
        role: m.role,
        snippet: excerpt(
          m.role === "user" ? m.content : m.meta?.synthesis || m.content || text,
          q,
        ),
        matchLabel: m.role === "user" ? "用户消息" : "助手回答",
        updatedAt: s.updatedAt ?? 0,
        score: bodyScore + (m.role === "user" ? 8 : 4),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  if (!q) return hits.slice(0, Math.min(limit, 24));
  return hits.filter((h) => h.score > 0).slice(0, limit);
}

export function formatHistoryHitWhen(ts: number): string {
  return formatWhen(ts);
}
