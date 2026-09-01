# -*- coding: utf-8 -*-
"""Render structured report content to a Chinese-capable PDF with ReportLab."""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

FONT = "STSong-Light"
NAVY = colors.HexColor("#1E3A5F")
BLUE = colors.HexColor("#2E74B5")
TEXT = colors.HexColor("#334155")
MUTED = colors.HexColor("#64748B")
HEADER_FILL = colors.HexColor("#E8EEF5")
BORDER = colors.HexColor("#CBD5E1")


class ProcessFlow(Flowable):
    def __init__(self, steps, width=6.2 * inch):
        super().__init__()
        self.steps = steps[:12]
        self.width = width
        self.box_h = 30
        self.gap = 14
        self.height = max(0, len(self.steps) * self.box_h + max(0, len(self.steps) - 1) * self.gap)

    def draw(self):
        canvas = self.canv
        x = 14
        box_w = self.width - 28
        for index, step in enumerate(self.steps):
            y = self.height - (index + 1) * self.box_h - index * self.gap
            canvas.setFillColor(colors.white)
            canvas.setStrokeColor(TEXT)
            canvas.roundRect(x, y, box_w, self.box_h, 5, fill=1, stroke=1)
            canvas.setFillColor(TEXT)
            canvas.setFont(FONT, 9)
            action = str(step.get("action") or "").strip()
            label = f"{step.get('step_no', index + 1)}. {action}"[:82]
            canvas.drawString(x + 9, y + 18, label)
            extra = " -> ".join(str(step.get(key) or "").strip() for key in ("inputs", "outputs") if str(step.get(key) or "").strip())
            if extra:
                canvas.setFillColor(MUTED)
                canvas.setFont(FONT, 7.5)
                canvas.drawString(x + 9, y + 7, extra[:100])
            if index < len(self.steps) - 1:
                canvas.setStrokeColor(MUTED)
                cx = x + box_w / 2
                canvas.line(cx, y, cx, y - self.gap + 5)
                canvas.line(cx, y - self.gap + 5, cx - 3, y - self.gap + 9)
                canvas.line(cx, y - self.gap + 5, cx + 3, y - self.gap + 9)


def para(text, style):
    return Paragraph(html.escape(str(text or "")).replace("\n", "<br/>") , style)


def make_table(headers, rows, widths, styles):
    data = [[para(h, styles["table_head"]) for h in headers]]
    data.extend([[para(value, styles["table_cell"]) for value in row] for row in rows])
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_FILL),
        ("GRID", (0, 0), (-1, -1), 0.45, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: render_artifact_pdf.py <input.json> <output.pdf>", file=sys.stderr)
        return 2
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    pdfmetrics.registerFont(UnicodeCIDFont(FONT))
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="title_cn", parent=styles["Title"], fontName=FONT, fontSize=24, leading=30, textColor=NAVY, alignment=TA_CENTER, spaceAfter=8))
    styles.add(ParagraphStyle(name="subtitle_cn", parent=styles["Normal"], fontName=FONT, fontSize=10, leading=15, textColor=MUTED, alignment=TA_CENTER, spaceAfter=18))
    styles.add(ParagraphStyle(name="h1_cn", parent=styles["Heading1"], fontName=FONT, fontSize=16, leading=21, textColor=BLUE, spaceBefore=14, spaceAfter=7, keepWithNext=True))
    styles.add(ParagraphStyle(name="body_cn", parent=styles["BodyText"], fontName=FONT, fontSize=10.5, leading=17, textColor=TEXT, spaceAfter=5))
    styles.add(ParagraphStyle(name="table_head", parent=styles["BodyText"], fontName=FONT, fontSize=8.5, leading=11, textColor=TEXT))
    styles.add(ParagraphStyle(name="table_cell", parent=styles["BodyText"], fontName=FONT, fontSize=8.3, leading=11, textColor=TEXT))
    styles.add(ParagraphStyle(name="caption_cn", parent=styles["BodyText"], fontName=FONT, fontSize=8.5, leading=12, textColor=MUTED, alignment=TA_CENTER, spaceAfter=8))

    doc = SimpleDocTemplate(str(output), pagesize=LETTER, rightMargin=0.72 * inch, leftMargin=0.72 * inch, topMargin=0.72 * inch, bottomMargin=0.68 * inch, title=str(payload.get("title") or "方案汇报"), author="犀材")
    story = [Spacer(1, 1.25 * inch), para(payload.get("title") or "方案汇报", styles["title_cn"]), para("由检索综述与结构化方案自动生成", styles["subtitle_cn"]), Spacer(1, 0.15 * inch)]

    for section in payload.get("sections") or []:
        story.append(para(section.get("head") or "方案要点", styles["h1_cn"]))
        for bullet in section.get("bullets") or []:
            story.append(para(f"- {bullet}", styles["body_cn"]))

    recipes = payload.get("recipes") or []
    if recipes:
        story.append(para("配方 / 组分摘录", styles["h1_cn"]))
        for recipe in recipes:
            story.append(para(f"- {recipe}", styles["body_cn"]))

    steps = payload.get("steps") or []
    if steps:
        story.append(para("工艺流程图", styles["h1_cn"]))
        story.append(KeepTogether([ProcessFlow(steps), para("工艺步骤结构化示意", styles["caption_cn"])]))
        story.append(para("工序列表", styles["h1_cn"]))
        step_rows = [[str(s.get("step_no") or i + 1), str(s.get("action") or ""), str(s.get("inputs") or ""), str(s.get("outputs") or ""), str(s.get("note") or "")] for i, s in enumerate(steps)]
        story.append(make_table(["步骤", "动作", "输入", "输出", "备注"], step_rows, [0.48 * inch, 2.0 * inch, 1.0 * inch, 1.0 * inch, 1.0 * inch], styles))

    rows = payload.get("rows") or []
    if rows:
        story.append(para("关键数据与指标", styles["h1_cn"]))
        data_rows = [[str(row.get(key) or "") for key in ("metric", "value", "unit", "condition", "source_ref")] for row in rows[:120]]
        story.append(make_table(["指标", "数值", "单位", "条件", "来源"], data_rows, [1.35 * inch, 0.85 * inch, 0.65 * inch, 2.05 * inch, 1.2 * inch], styles))

    if not (payload.get("sections") or recipes or steps or rows):
        story.append(para("暂无可用结构化内容，请先生成含配方或工序的综述后再导出。", styles["body_cn"]))

    def draw_footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont(FONT, 8)
        canvas.setFillColor(MUTED)
        canvas.drawCentredString(LETTER[0] / 2, 0.35 * inch, "由检索综述与结构化方案自动生成")
        canvas.restoreState()

    doc.build(story, onFirstPage=draw_footer, onLaterPages=draw_footer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
