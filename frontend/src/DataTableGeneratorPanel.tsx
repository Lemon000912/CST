import { useMemo, useState } from "react";
import type { ChatMessage } from "./types";
import {
  DATA_TABLE_PRESETS,
  type DataTablePresetId,
  type GeneratedDataTable,
} from "./dataTablePresets";

type Props = {
  msg: ChatMessage;
  busy?: boolean;
  onGenerate: (msg: ChatMessage, tableType: DataTablePresetId) => void | Promise<void>;
};

function DataTableView({ table }: { table: GeneratedDataTable }) {
  if (!table.rows.length) {
    return <p className="text-[11px] text-[var(--t-text-dim)]">该类型未抽取到可列出的数据行。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] border-collapse text-left text-[11px]">
        <thead>
          <tr className="border-b border-[color:var(--t-br08)] text-[var(--t-text-label)]">
            <th className="py-1.5 pr-2 font-medium">指标</th>
            <th className="py-1.5 pr-2 font-medium">数值</th>
            <th className="py-1.5 pr-2 font-medium">单位</th>
            <th className="py-1.5 pr-2 font-medium">条件/样品</th>
            <th className="py-1.5 font-medium">来源</th>
          </tr>
        </thead>
        <tbody className="text-[var(--t-text-card-body)]">
          {table.rows.map((r, i) => (
            <tr key={i} className="border-b border-[color:var(--t-br05)] align-top">
              <td className="py-1.5 pr-2 font-medium text-[var(--t-text)]">{r.metric ?? "—"}</td>
              <td className="py-1.5 pr-2 tabular-nums">{r.value ?? "—"}</td>
              <td className="py-1.5 pr-2">{r.unit ?? "—"}</td>
              <td className="max-w-[10rem] py-1.5 pr-2">{r.condition ?? r.material ?? "—"}</td>
              <td className="py-1.5 text-[var(--t-text-dim)]">{r.source_ref ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataTableGeneratorPanel({ msg, busy, onGenerate }: Props) {
  const tables = msg.meta?.dataTables ?? {};
  const generatedIds = Object.keys(tables);
  const [selected, setSelected] = useState<DataTablePresetId>(
    (msg.meta?.activeDataTableType as DataTablePresetId) || "performance",
  );
  const [viewType, setViewType] = useState<string>(
    msg.meta?.activeDataTableType || generatedIds[0] || "performance",
  );

  const activeTable = tables[viewType];
  const selectedPreset = useMemo(
    () => DATA_TABLE_PRESETS.find((p) => p.id === selected),
    [selected],
  );

  return (
    <div className="mt-3 rounded-xl border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-3">
      <p className="mb-1 text-[11px] font-semibold text-[var(--t-text)]">数据表生成（数据库渠道）</p>
      <p className="mb-2 text-[10px] leading-relaxed text-[var(--t-text-dim)]">
        选择表类型后点击生成，可从文献摘录与综述中抽取<strong>不同类型</strong>的结构化表格；可多次生成并切换查看。
      </p>
      {msg.meta?.dataTableError ? (
        <p className="mb-2 rounded-lg border border-[color:var(--t-error)]/35 bg-[color:var(--t-error)]/08 px-2 py-1.5 text-[10px] text-[var(--t-error)]">
          {msg.meta.dataTableError}
        </p>
      ) : null}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {DATA_TABLE_PRESETS.map((p) => {
          const on = selected === p.id;
          const done = Boolean(tables[p.id]?.rows?.length);
          return (
            <button
              key={p.id}
              type="button"
              title={p.description}
              disabled={!!busy}
              onClick={() => setSelected(p.id)}
              className={`rounded-lg border px-2.5 py-1 text-[10px] font-medium transition ${
                on
                  ? "border-[color:var(--t-accent-ring)] bg-[var(--t-accent-muted)] text-[var(--t-text)]"
                  : "border-[color:var(--t-br10)] bg-[var(--t-surface)] text-[var(--t-text-muted)] hover:bg-[var(--t-elevated)]"
              }`}
            >
              {p.label}
              {done ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      {selectedPreset ? (
        <p className="mb-2 text-[10px] text-[var(--t-text-dim)]">{selectedPreset.description}</p>
      ) : null}
      <button
        type="button"
        disabled={!!busy}
        onClick={() => void onGenerate(msg, selected)}
        className="qp-btn-accent rounded-lg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
      >
        {busy ? "生成中…" : `生成「${selectedPreset?.label ?? "数据"}」表`}
      </button>
      {generatedIds.length > 0 ? (
        <div className="mt-3 border-t border-[color:var(--t-br06)] pt-3">
          <div className="mb-2 flex flex-wrap gap-1">
            {generatedIds.map((id) => {
              const preset = DATA_TABLE_PRESETS.find((p) => p.id === id);
              const t = tables[id];
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setViewType(id)}
                  className={`rounded-md border px-2 py-0.5 text-[10px] ${
                    viewType === id
                      ? "border-[color:var(--t-accent-ring)] bg-[var(--t-accent-muted)] text-[var(--t-text)]"
                      : "border-[color:var(--t-br08)] text-[var(--t-text-dim)] hover:bg-[var(--t-elevated)]"
                  }`}
                >
                  {t?.title || preset?.label || id}
                  {t?.rows?.length ? ` (${t.rows.length})` : ""}
                </button>
              );
            })}
          </div>
          {activeTable ? (
            <div>
              <p className="mb-2 text-[11px] font-medium text-[var(--t-text)]">{activeTable.title}</p>
              <DataTableView table={activeTable} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
