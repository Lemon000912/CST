import { useCallback, useMemo, useState } from "react";
import type { Paper } from "./types";
import { resolveLiteratureUrl } from "./chartLinks";

type SpecPoint = {
  x: unknown;
  y: unknown;
  doi_x?: unknown;
  doi_y?: unknown;
  quote?: unknown;
  title?: unknown;
};

function pickOpenUrl(lx: string, ly: string, papers: Paper[]): string | null {
  return resolveLiteratureUrl(ly, papers) ?? resolveLiteratureUrl(lx, papers);
}

export function InteractivePaperChart({
  spec,
  papers,
}: {
  spec: Record<string, unknown>;
  papers: Paper[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const xLab = String((spec.x_axis as { label?: string } | undefined)?.label ?? "x");
  const yLab = String((spec.y_axis as { label?: string } | undefined)?.label ?? "y");

  const pts = useMemo(() => {
    const rawPts = spec.points;
    if (!Array.isArray(rawPts)) return [];
    const out: { x: number; y: number; lx: string; ly: string; quote: string; title: string }[] = [];
    for (const p of rawPts) {
      if (!p || typeof p !== "object") continue;
      const sp = p as SpecPoint;
      const x = Number(sp.x);
      const y = Number(sp.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const lx = String(sp.doi_x ?? "—").trim();
      const ly = String(sp.doi_y ?? "—").trim();
      const quote = String(sp.quote ?? "").trim();
      const title = String(sp.title ?? "").trim().slice(0, 80);
      out.push({ x, y, lx, ly, quote, title });
    }
    return out;
  }, [spec]);

  const ptsWithJitter = useMemo(() => {
    if (!pts.length) return [];
    const xRange = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)) || 1;
    const yRange = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)) || 1;
    const epsX = Math.max(xRange * 0.06, 0.25);
    const epsY = Math.max(yRange * 0.02, 0.02);
    const isDiscreteX = xRange <= 10 && pts.every(p => Math.abs(p.x - Math.round(p.x)) < 0.01) && pts.length >= 3;

    const grouped = new Map<string, { x: number; y: number; lx: string; ly: string; quote: string; title: string }[]>();
    for (const p of pts) {
      const gx = Math.round(p.x / epsX) * epsX;
      const gy = Math.round(p.y / epsY) * epsY;
      const key = `${gx.toFixed(4)}_${gy.toFixed(4)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(p);
    }
    const result: { x: number; y: number; lx: string; ly: string; quote: string; title: string }[] = [];
    for (const [, group] of grouped) {
      if (group.length === 1) {
        result.push(group[0]);
      } else {
        const half = (group.length - 1) / 2;
        for (let i = 0; i < group.length; i++) {
          const offset = (i - half) * epsX * 0.55;
          result.push({
            ...group[i],
            x: group[i].x + offset,
            y: isDiscreteX ? group[i].y + (i - half) * epsY * 0.12 : group[i].y,
          });
        }
      }
    }
    return result;
  }, [pts]);

  const layout = useMemo(() => {
    if (!ptsWithJitter.length) return null;
    let minX = ptsWithJitter[0].x;
    let maxX = ptsWithJitter[0].x;
    let minY = ptsWithJitter[0].y;
    let maxY = ptsWithJitter[0].y;
    for (const p of ptsWithJitter) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const padX = Math.max((maxX - minX) * 0.12, 0.5);
    const padY = Math.max((maxY - minY) * 0.12, 0.5);
    minX -= padX;
    maxX += padX;
    minY -= padY;
    maxY += padY;
    if (minX === maxX) {
      minX -= 1;
      maxX += 1;
    }
    if (minY === maxY) {
      minY -= 1;
      maxY += 1;
    }
    return { minX, maxX, minY, maxY };
  }, [ptsWithJitter]);

  const onPointClick = useCallback(
    (lx: string, ly: string) => {
      const url = pickOpenUrl(lx, ly, papers);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
    [papers],
  );

  if (!ptsWithJitter.length || !layout) return null;

  const W = 520;
  const H = 340;
  const left = 52;
  const right = W - 18;
  const top = 22;
  const bottom = H - 48;

  const sx = (x: number) => left + ((x - layout.minX) / (layout.maxX - layout.minX)) * (right - left);
  const sy = (y: number) => bottom - ((y - layout.minY) / (layout.maxY - layout.minY)) * (bottom - top);

  return (
    <div className="mt-2 rounded-lg border border-[color:var(--t-br08)] bg-white p-2">
      <p className="mb-1.5 text-[10px] font-medium text-[var(--t-text-muted)]">
        可点击散点：优先打开纵轴文献链接，其次横轴（新标签页）
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-full text-[var(--t-text)]"
        role="img"
        aria-label="交互式文献数值散点图"
      >
        <rect x="0" y="0" width={W} height={H} fill="#fafafa" rx="6" />
        <line x1={left} y1={bottom} x2={right} y2={bottom} stroke="#94a3b8" strokeWidth="1" />
        <line x1={left} y1={top} x2={left} y2={bottom} stroke="#94a3b8" strokeWidth="1" />
        <text x={W / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#64748b">
          {xLab}
        </text>
        <text
          x="14"
          y={H / 2}
          textAnchor="middle"
          fontSize="11"
          fill="#64748b"
          transform={`rotate(-90, 14, ${H / 2})`}
        >
          {yLab}
        </text>
        {ptsWithJitter.map((p, i) => {
          const cx = sx(p.x);
          const cy = sy(p.y);
          const url = pickOpenUrl(p.lx, p.ly, papers);
          const canClick = !!url;
          const r = hover === i ? 9 : 7;
          return (
            <g key={i}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={canClick ? "#0d9488" : "#94a3b8"}
                stroke="#065f46"
                strokeWidth="0.6"
                className={canClick ? "cursor-pointer" : "cursor-default"}
                style={{ transition: "r 0.12s ease" }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  if (canClick) onPointClick(p.lx, p.ly);
                }}
              />
              <title>
                {p.title ? `${p.title}\n` : ""}{`x=${p.x.toFixed(2)}, y=${p.y.toFixed(2)}\n${p.ly !== p.lx ? `纵: ${p.ly}\n横: ${p.lx}` : p.ly}`}
                {p.quote ? `\n摘录: ${p.quote}` : ""}
                {canClick ? "\n点击打开链接" : "\n（无可用链接）"}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
