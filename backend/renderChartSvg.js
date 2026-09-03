/**
 * Pure-JS SVG scatter chart renderer — no Python/matplotlib dependency.
 * Used as fallback when renderChartPngWithMatplotlib fails (e.g. Python not installed).
 */

export function renderScatterChartSvg(spec) {
  const width = 800;
  const height = 520;
  const margin = { top: 60, right: 40, bottom: 80, left: 80 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const rawPoints = (spec.points || []).filter(
    (p) => p != null && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
  );
  if (rawPoints.length === 0) return null;

  const xs = rawPoints.map((p) => Number(p.x));
  const ys = rawPoints.map((p) => Number(p.y));
  const xMinRaw = Math.min(...xs);
  const xMaxRaw = Math.max(...xs);
  const yMinRaw = Math.min(...ys);
  const yMaxRaw = Math.max(...ys);
  const xRange = xMaxRaw - xMinRaw || 1;
  const yRange = yMaxRaw - yMinRaw || 1;

  const epsX = Math.max(xRange * 0.06, 0.25);
  const epsY = Math.max(yRange * 0.02, 0.02);

  const groups = new Map();
  for (const p of rawPoints) {
    const gx = Math.round(Number(p.x) / epsX) * epsX;
    const gy = Math.round(Number(p.y) / epsY) * epsY;
    const key = `${gx.toFixed(4)}_${gy.toFixed(4)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const points = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      points.push(group[0]);
    } else {
      const half = (group.length - 1) / 2;
      for (let i = 0; i < group.length; i++) {
        points.push({
          ...group[i],
          x: Number(group[i].x) + (i - half) * epsX * 0.55,
        });
      }
    }
  }

  const xMin = Math.min(...points.map((p) => Number(p.x)));
  const xMax = Math.max(...points.map((p) => Number(p.x)));
  const yMin = Math.min(...points.map((p) => Number(p.y)));
  const yMax = Math.max(...points.map((p) => Number(p.y)));
  const xPad = (xMax - xMin) * 0.08 || 1;
  const yPad = (yMax - yMin) * 0.08 || 1;

  const scaleX = (v) => margin.left + ((Number(v) - (xMin - xPad)) / (xMax - xMin + 2 * xPad)) * plotW;
  const scaleY = (v) => margin.top + plotH - ((Number(v) - (yMin - yPad)) / (yMax - yMin + 2 * yPad)) * plotH;

  const tickCount = Math.min(8, Math.max(3, Math.floor(points.length / 5)));
  const xTicks = linspace(xMin, xMax, tickCount);
  const yTicks = linspace(yMin, yMax, tickCount);

  const title = String(spec.title || "Research Progress Chart").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c);
  const xLabel = String(spec.x_axis?.label || "Year").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c);
  const yLabel = String(spec.y_axis?.label || "Value").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c);

  const colors = [
    "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c",
    "#0891b2", "#be123c", "#4f46e5", "#a21caf", "#0d9488",
  ];
  // Prefer CJK-capable fonts so Chinese labels remain legible on systems where
  // the generic sans-serif family only contains Latin glyphs.
  const fontFamily = "Microsoft YaHei, SimHei, PingFang SC, Noto Sans CJK SC, Arial, sans-serif";

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff" rx="8"/>`;

  // Title
  svg += `<text x="${width / 2}" y="32" text-anchor="middle" font-family="${fontFamily}" font-size="16" font-weight="bold" fill="#1e293b">${title}</text>`;

  // Grid lines
  for (const tx of xTicks) {
    const x = scaleX(tx);
    svg += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotH}" stroke="#e2e8f0" stroke-width="1"/>`;
  }
  for (const ty of yTicks) {
    const y = scaleY(ty);
    svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
  }

  // Axes
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#334155" stroke-width="1.5"/>`;
  svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#334155" stroke-width="1.5"/>`;

  // X ticks
  for (const tx of xTicks) {
    const x = scaleX(tx);
    const label = Number.isInteger(tx) ? String(tx) : tx.toFixed(1);
    svg += `<text x="${x}" y="${margin.top + plotH + 20}" text-anchor="middle" font-family="${fontFamily}" font-size="11" fill="#475569">${label}</text>`;
    svg += `<line x1="${x}" y1="${margin.top + plotH}" x2="${x}" y2="${margin.top + plotH + 5}" stroke="#334155" stroke-width="1"/>`;
  }

  // Y ticks
  for (const ty of yTicks) {
    const y = scaleY(ty);
    const label = Number.isFinite(ty) ? (Math.abs(ty) < 0.01 ? ty.toExponential(2) : Math.abs(ty) >= 1000 ? ty.toFixed(0) : ty.toFixed(1)) : String(ty);
    svg += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-family="${fontFamily}" font-size="11" fill="#475569">${label}</text>`;
    svg += `<line x1="${margin.left - 5}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="#334155" stroke-width="1"/>`;
  }

  // Axis labels
  svg += `<text x="${width / 2}" y="${height - 12}" text-anchor="middle" font-family="${fontFamily}" font-size="13" font-weight="600" fill="#1e293b">${xLabel}</text>`;
  svg += `<text x="16" y="${height / 2}" text-anchor="middle" font-family="${fontFamily}" font-size="13" font-weight="600" fill="#1e293b" transform="rotate(-90, 16, ${height / 2})">${yLabel}</text>`;

  // Scatter points
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cx = scaleX(p.x);
    const cy = scaleY(p.y);
    const color = colors[i % colors.length];
    const r = Math.min(8, Math.max(3, 30 / Math.sqrt(points.length)));
    const paperTitle = String(p.paper_title || p.reference || `Point ${i + 1}`).replace(/[<>&'"]/g, "").slice(0, 100);
    svg += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}" fill-opacity="0.75" stroke="#ffffff" stroke-width="1">`;
    svg += `<title>${paperTitle}\nx=${Number(p.x).toFixed(2)} y=${Number(p.y).toFixed(2)}</title>`;
    svg += `</circle>`;
  }

  svg += `</svg>`;
  return svg;
}

function linspace(start, end, count) {
  const arr = [];
  if (count <= 1) { arr.push(start); return arr; }
  const step = (end - start) / (count - 1);
  for (let i = 0; i < count; i++) arr.push(start + step * i);
  return arr;
}
