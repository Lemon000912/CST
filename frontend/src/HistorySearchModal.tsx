import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSession } from "./types";
import { formatHistoryHitWhen, searchChatHistory, type HistorySearchHit } from "./historySearch";

type Props = {
  open: boolean;
  sessions: ChatSession[];
  activeSessionId: string | null;
  onClose: () => void;
  onSelect: (sessionId: string, messageId: string | null) => void;
};

export function HistorySearchModal({ open, sessions, activeSessionId, onClose, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchChatHistory(sessions, query, 36), [sessions, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && results.length > 0) {
        e.preventDefault();
        const hit = results[activeIndex];
        if (hit) onSelect(hit.sessionId, hit.messageId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, activeIndex, onClose, onSelect]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hit-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  const pick = useCallback(
    (hit: HistorySearchHit) => {
      onSelect(hit.sessionId, hit.messageId);
    },
    [onSelect],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-[var(--t-overlay)] px-3 pb-8 pt-[min(12vh,5rem)] sm:px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-search-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[min(72vh,640px)] w-full max-w-[min(560px,100%)] flex-col overflow-hidden rounded-xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] shadow-lg shadow-[var(--t-modal-shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[color:var(--t-br06)] px-3 py-3 sm:px-4">
          <div className="flex items-center gap-2">
            <span className="text-[var(--t-text-dim)]" aria-hidden>
              ⌕
            </span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索历史对话、提问与回答…"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--t-text)] placeholder:text-[var(--t-placeholder-input)] focus:outline-none"
              aria-labelledby="history-search-title"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="hidden shrink-0 rounded border border-[color:var(--t-br08)] bg-[var(--t-field)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--t-text-dim)] sm:inline">
              Esc
            </kbd>
          </div>
          <p id="history-search-title" className="mt-2 text-[10px] text-[var(--t-text-dim)]">
            <span className="font-medium text-[var(--t-text-muted)]">Ctrl+K</span> 打开 · ↑↓ 选择 · Enter 跳转
            {query.trim() ? (
              <span className="ml-2">
                共 {results.length} 条匹配
              </span>
            ) : (
              <span className="ml-2">留空显示最近对话与消息</span>
            )}
          </p>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-3">
          {results.length === 0 ? (
            <p className="px-2 py-8 text-center text-[13px] text-[var(--t-text-dim)]">
              {query.trim() ? "没有匹配的历史记录" : "暂无已保存的对话"}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {results.map((hit, idx) => {
                const active = idx === activeIndex;
                const isCurrent = hit.sessionId === activeSessionId;
                return (
                  <li key={`${hit.sessionId}-${hit.messageId ?? "t"}-${hit.matchLabel}-${idx}`}>
                    <button
                      type="button"
                      data-hit-idx={idx}
                      onClick={() => pick(hit)}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                        active
                          ? "border-[color:var(--t-accent-ring)] bg-[var(--t-llm-row-hover-bg)]"
                          : "border-transparent hover:border-[color:var(--t-br06)] hover:bg-[var(--t-muted)]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--t-text)]">
                          {hit.sessionTitle}
                          {isCurrent ? (
                            <span className="ml-1.5 text-[10px] font-normal text-[var(--t-accent)]">当前</span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-[10px] text-[var(--t-text-dim)]">
                          {formatHistoryHitWhen(hit.updatedAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className="shrink-0 rounded bg-[var(--t-field)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--t-text-label)]">
                          {hit.matchLabel}
                        </span>
                      </div>
                      {hit.snippet ? (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--t-text-muted)]">
                          {hit.snippet}
                        </p>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
