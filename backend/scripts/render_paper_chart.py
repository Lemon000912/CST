# -*- coding: utf-8 -*-
"""Read chart JSON from argv[1], write PNG to argv[2]. Used by backend/paperChart.js (Matplotlib)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import gridspec  # noqa: E402


def _short(s: str, n: int = 22) -> str:
    t = str(s or "").strip()
    if len(t) <= n:
        return t
    return t[: n - 1] + "…"


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: render_paper_chart.py <in.json> <out.png>", file=sys.stderr)
        return 2
    in_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    spec = json.loads(in_path.read_text(encoding="utf-8"))

    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    title = str(spec.get("title") or "文献数值图").strip()
    x_lab = str(spec.get("x_axis", {}).get("label") or "x").strip()
    y_lab = str(spec.get("y_axis", {}).get("label") or "y").strip()
    points = spec.get("points") or []
    if not isinstance(points, list) or not points:
        print("no points", file=sys.stderr)
        return 1

    xs: list[float] = []
    ys: list[float] = []
    dx: list[str] = []
    dy: list[str] = []
    titles: list[str] = []
    for p in points:
        if not isinstance(p, dict):
            continue
        try:
            xv = float(p["x"])
            yv = float(p["y"])
        except (KeyError, TypeError, ValueError):
            continue
        doi = str(p.get("doi") or "").strip()
        dxi = str(p.get("doi_x") or doi or "").strip() or "—"
        dyi = str(p.get("doi_y") or doi or "").strip() or "—"
        ttl = str(p.get("title") or "").strip()
        xs.append(xv)
        ys.append(yv)
        dx.append(dxi)
        dy.append(dyi)
        titles.append(ttl)

    if not xs:
        print("no numeric points", file=sys.stderr)
        return 1

    # 检测重叠标注并做偏移
    used_positions: dict[tuple[float, float], int] = {}
    offsets: list[tuple[float, float]] = []

    def _round_xy(x: float, y: float, prec: int = 3) -> tuple[float, float]:
        return (round(x, prec), round(y, prec))

    for x, y in zip(xs, ys):
        key = _round_xy(x, y)
        idx = used_positions.get(key, 0)
        used_positions[key] = idx + 1
        if idx == 0:
            offsets.append((4, 4))
        else:
            offsets.append((4 + idx * 14, 4 + idx * 14))

    fig = plt.figure(figsize=(10, 7.2), dpi=120)
    gs = gridspec.GridSpec(2, 1, height_ratios=[2.2, 1], hspace=0.35)
    ax = fig.add_subplot(gs[0])
    ax.scatter(xs, ys, s=56, c="#0d8f6e", edgecolors="#065f46", linewidths=0.6, zorder=3)
    ax.set_title(title, fontsize=12, pad=10)
    ax.set_xlabel(x_lab + "\n（下表：每点横/纵坐标对应 DOI）", fontsize=10)
    ax.set_ylabel(y_lab + "\n（下表：每点横/纵坐标对应 DOI）", fontsize=10)
    ax.grid(True, linestyle="--", alpha=0.35)

    for i, (x, y) in enumerate(zip(xs, ys)):
        ix = dx[i]
        iy = dy[i]
        ttl = titles[i]
        ttl_short = ttl[:30] + ("..." if len(ttl) > 30 else "")
        if ttl_short and ix != iy:
            tag = f"{ttl_short}\nX:{_short(ix,12)}\nY:{_short(iy,12)}"
        elif ttl_short:
            tag = f"{ttl_short}\n[{_short(ix,20)}]"
        else:
            tag = _short(ix if ix == iy else f"X:{_short(ix,14)} Y:{_short(iy,14)}", 36)
        ox, oy = offsets[i]
        ax.annotate(
            tag,
            (x, y),
            textcoords="offset points",
            xytext=(ox, oy),
            fontsize=6.5,
            color="#374151",
            alpha=0.92,
            bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="none", alpha=0.7),
        )

    ax_tbl = fig.add_subplot(gs[1])
    ax_tbl.axis("off")
    rows = []
    for i, (x, y, ix, iy, ttl) in enumerate(zip(xs, ys, dx, dy, titles), start=1):
        ttl_short = _short(ttl, 40) if ttl else "—"
        rows.append([str(i), ttl_short, f"{x:g}", f"{y:g}", ix or "—", iy or "—"])
    col_labels = ["#", "论文标题", "横坐标 x", "纵坐标 y", "DOI（横轴依据）", "DOI（纵轴依据）"]
    tbl = ax_tbl.table(
        cellText=rows,
        colLabels=col_labels,
        loc="center",
        cellLoc="left",
        colLoc="left",
    )
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(7)
    tbl.scale(1.05, 1.35)
    for (r, c), cell in tbl.get_celld().items():
        if r == 0:
            cell.set_facecolor("#e5e7eb")
            cell.set_text_props(weight="bold")

    fig.savefig(out_path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
