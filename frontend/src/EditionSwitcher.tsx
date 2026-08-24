import type { AppEdition } from "./edition";

export function EditionSwitcher({
  edition,
  onChange,
  compact = false,
}: {
  edition: AppEdition;
  onChange: (edition: AppEdition) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-2 border border-[color:var(--t-br08)] bg-[var(--t-muted)] p-0.5 ${
        compact ? "rounded-md text-[10px]" : "rounded-lg text-[12px]"
      }`}
      role="group"
      aria-label="选择应用版本"
    >
      {(["school", "enterprise"] as const).map((value) => {
        const active = edition === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={`${compact ? "rounded px-2 py-1" : "rounded-md px-3 py-1.5"} font-medium transition ${
              active
                ? "bg-[var(--t-surface)] text-[var(--t-text)] shadow-sm"
                : "text-[var(--t-text-muted)] hover:text-[var(--t-text)]"
            }`}
          >
            {value === "school" ? "学校版" : "企业版"}
          </button>
        );
      })}
    </div>
  );
}
