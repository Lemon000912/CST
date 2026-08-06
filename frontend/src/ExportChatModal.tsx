import { useEffect, useState } from "react";
import { exportSessionsToFile, filterSessionMessagesByIdSet, type ExportFormat } from "./exportChat";
import { LOADING_EXPORT } from "./loadingCopy";
import type { ChatSession } from "./types";

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "markdown", label: "Markdown", hint: ".md" },
  { id: "docx", label: "Word", hint: ".docx" },
  { id: "pdf", label: "PDF", hint: ".pdf" },
  { id: "json", label: "JSON", hint: ".json（原始结构）" },
];

export function ExportChatModal({
  open,
  sessions,
  activeId,
  partialExport,
  onClose,
  onClearPartialExport,
  onStartPickMessages,
}: {
  open: boolean;
  sessions: ChatSession[];
  activeId: string | null;
  /** 仅单会话：在对话里勾选后的子集；null 表示导出该会话全部消息 */
  partialExport: { sessionId: string; ids: ReadonlySet<string> } | null;
  onClose: () => void;
  onClearPartialExport: () => void;
  /** 关闭弹窗并进入对话多选（仅当前勾选的单个会话） */
  onStartPickMessages: (sessionId: string) => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next: Record<string, boolean> = {};
    const defaultId = activeId && sessions.some((s) => s.id === activeId) ? activeId : sessions[0]?.id;
    for (const s of sessions) next[s.id] = defaultId != null && s.id === defaultId;
    setSelected(next);
    setFormat("markdown");
  }, [open, sessions, activeId]);

  const chosenCount = sessions.filter((s) => selected[s.id]).length;
  const soleSession = chosenCount === 1 ? sessions.find((s) => selected[s.id]) : undefined;

  useEffect(() => {
    if (!open || !partialExport) return;
    if (!soleSession || soleSession.id !== partialExport.sessionId) onClearPartialExport();
  }, [open, soleSession?.id, partialExport, onClearPartialExport]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const selectAll = () => {
    setSelected(Object.fromEntries(sessions.map((s) => [s.id, true])));
  };

  const selectNone = () => {
    setSelected(Object.fromEntries(sessions.map((s) => [s.id, false])));
  };

  const runExport = async () => {
    const chosen = sessions.filter((s) => selected[s.id]);
    if (!chosen.length) {
      window.alert("请至少勾选一个会话");
      return;
    }
    let payload = chosen;
    if (chosen.length === 1) {
      const s0 = chosen[0];
      const part = partialExport;
      if (part && part.sessionId === s0.id) {
        if (part.ids.size === 0) {
          window.alert("请至少勾选一条消息，或清除部分导出后重试");
          return;
        }
        const n = s0.messages.length;
        const full = n > 0 && part.ids.size === n && s0.messages.every((m) => part.ids.has(m.id));
        if (!full) {
          payload = [filterSessionMessagesByIdSet(s0, part.ids)];
        }
      }
    }
    setBusy(true);
    try {
      await exportSessionsToFile(payload, format);
      onClose();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--t-overlay)] px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-chat-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[min(90vh,640px)] w-full max-w-[min(440px,100%)] flex-col rounded-xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] shadow-lg shadow-[var(--t-modal-shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-[color:var(--t-br06)] p-4">
          <h2 id="export-chat-title" className="text-[15px] font-semibold text-[var(--t-text-card-title)]">
            导出聊天记录
          </h2>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--t-text-faint)]">
            勾选要导出的会话，再选择格式。多会话会合并进同一文件（Word / PDF 会分页）。仅勾选
            <b className="text-[var(--t-text-muted)]">一个</b>
            会话时，可到对话里勾选要导出的消息。
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-2 flex gap-2 text-[10px]">
            <button
              type="button"
              onClick={selectAll}
              className="rounded-md border border-[color:var(--t-br08)] px-2 py-1 text-[var(--t-text-muted)] hover:bg-[color:var(--t-br-hover05)]"
            >
              全选
            </button>
            <button
              type="button"
              onClick={selectNone}
              className="rounded-md border border-[color:var(--t-br08)] px-2 py-1 text-[var(--t-text-muted)] hover:bg-[color:var(--t-br-hover05)]"
            >
              全不选
            </button>
            <span className="ml-auto self-center text-[var(--t-text-caption)]">已选 {chosenCount} 个</span>
          </div>
          <ul className="flex flex-col gap-1.5" aria-label="会话列表">
            {sessions.map((s) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[color:var(--t-br07)] bg-[var(--t-field)] px-2.5 py-2 hover:border-[color:var(--t-br10)]">
                  <input
                    type="checkbox"
                    className="qp-accent-input mt-0.5 h-3.5 w-3.5 shrink-0"
                    checked={!!selected[s.id]}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="min-w-0 flex-1 text-left text-[12px] leading-snug text-[var(--t-text)]">
                    <span className="line-clamp-2">{s.title}</span>
                    <span className="mt-0.5 block font-mono text-[9px] text-[var(--t-text-dim)]">
                      {s.messages.length} 条消息
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {soleSession ? (
            <div className="mt-3 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-2.5">
              <div className="text-[11px] font-semibold text-[var(--t-text-secondary)]">部分导出（当前 1 个会话）</div>
              <p className="mt-1 text-[10px] leading-relaxed text-[var(--t-text-caption)]">
                点击下方按钮进入对话，在每条消息左侧勾选；默认全选，去掉不需要的即可。完成后点「完成选择」回到此处再导出。
              </p>
              {partialExport && partialExport.sessionId === soleSession.id ? (
                <p className="mt-1.5 text-[10px] text-[var(--t-text-muted)]">
                  当前将导出其中{" "}
                  <b className="text-[var(--t-text)]">{partialExport.ids.size}</b> / {soleSession.messages.length}{" "}
                  条消息。
                  <button
                    type="button"
                    className="ml-2 underline decoration-[color:var(--t-br12)] decoration-1 underline-offset-2 hover:text-[var(--t-text)]"
                    onClick={onClearPartialExport}
                  >
                    清除选择（改回全部）
                  </button>
                </p>
              ) : (
                <p className="mt-1.5 text-[10px] text-[var(--t-text-caption)]">未做勾选筛选时将导出本会话全部消息。</p>
              )}
              <button
                type="button"
                disabled={soleSession.messages.length === 0}
                onClick={() => onStartPickMessages(soleSession.id)}
                className="mt-2.5 w-full rounded-lg border border-[color:var(--t-accent-ring)] bg-[var(--t-llm-row-hover-bg)] px-3 py-2 text-[12px] font-medium text-[var(--t-text)] transition hover:border-[color:var(--t-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                到对话里选择消息…
              </button>
            </div>
          ) : chosenCount > 1 ? (
            <p className="mt-3 text-[10px] leading-relaxed text-[var(--t-text-caption)]">
              已选多个会话：将导出各会话中的<strong>全部</strong>消息。若只需其中一部分，请只勾选一个会话后使用「到对话里选择消息」。
            </p>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-[color:var(--t-br06)] p-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--t-text-micro)]">
            导出格式
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                className={`rounded-lg border px-2 py-2 text-center text-[11px] font-medium transition ${
                  format === f.id
                    ? "border-[color:var(--t-accent-ring)] bg-[var(--t-llm-row-hover-bg)] text-[var(--t-text)]"
                    : "border-[color:var(--t-br08)] text-[var(--t-text-muted)] hover:border-[color:var(--t-br10)]"
                }`}
              >
                <div>{f.label}</div>
                <div className="mt-0.5 text-[9px] font-normal opacity-80">{f.hint}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 border-t border-[color:var(--t-br06)] p-4">
          <button
            type="button"
            disabled={busy || chosenCount === 0}
            onClick={() => void runExport()}
            className="qp-btn-accent rounded-lg px-4 py-2 text-[13px] shadow-md"
          >
            {busy ? LOADING_EXPORT : "导出"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="ml-auto rounded-lg px-3 py-2 text-[13px] text-[var(--t-text-close)] hover:text-[var(--t-text-close-hover)]"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
