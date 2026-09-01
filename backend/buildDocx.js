import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { collectProcessSteps, extractRecipeLines } from "./processArtifacts.js";

const FONT = "Calibri";
const CJK_FONT = "Microsoft YaHei";
const BLUE = "2E74B5";
const TEXT = "334155";
const BORDER = "CBD5E1";
const HEADER_FILL = "E8EEF5";
const TABLE_WIDTH = 9360;

function cleanInline(value) {
  return String(value ?? "")
    .replace(/\*\*/g, "")
    .replace(/\*(?!\*)/g, "")
    .replace(/`+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMarkdownSections(markdown, maxSections = 14) {
  const text = String(markdown ?? "").trim();
  if (!text) return [];
  const sections = [];
  const parts = text.split(/\n(?=#{1,3}\s)/);
  for (const part of parts) {
    const lines = part.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const head = cleanInline(lines[0].replace(/^#+\s*/, "")).slice(0, 80);
    const bullets = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("|") || line.startsWith("```")) continue;
      const list = line.match(/^[-*•]\s+(.+)/)?.[1] ?? line.match(/^\d+[.、．):：]\s+(.+)/)?.[1] ?? null;
      if (list) bullets.push(cleanInline(list).slice(0, 500));
      else if (!line.startsWith("#") && line.length >= 6) bullets.push(cleanInline(line).slice(0, 500));
    }
    if (!bullets.length) {
      const body = cleanInline(lines.slice(1).join(" ")).slice(0, 700);
      if (body) bullets.push(body);
    }
    if (head && bullets.length) sections.push({ head, bullets: bullets.slice(0, 12) });
    if (sections.length >= maxSections) break;
  }
  if (!sections.length) {
    const plain = cleanInline(text.replace(/^#+\s*/gm, "")).slice(0, 900);
    if (plain) sections.push({ head: "方案摘要", bullets: [plain] });
  }
  return sections;
}

function paragraph(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 120, line: 300 },
    alignment: opts.alignment,
    style: opts.style,
    children: [
      new TextRun({
        text: cleanInline(text),
        font: { name: FONT, eastAsia: CJK_FONT },
        size: opts.size ?? 22,
        bold: opts.bold,
        color: opts.color ?? TEXT,
      }),
    ],
  });
}

function tableCell(text, width, header = false) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    shading: header ? { type: ShadingType.CLEAR, fill: HEADER_FILL } : undefined,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
    },
    children: [paragraph(text, { size: header ? 20 : 19, bold: header, after: 0 })],
  });
}

function buildTable(headers, rows, widths) {
  const tableRows = [
    new TableRow({ children: headers.map((h, i) => tableCell(h, widths[i], true)) }),
    ...rows.map((row) => new TableRow({ children: row.map((value, i) => tableCell(value, widths[i])) })),
  ];
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: tableRows,
  });
}

/** Generate a Word document using the same extracted content as the PPT export. */
export async function buildDocxBuffer(opts) {
  const title = String(opts.title ?? "方案汇报").trim().slice(0, 120) || "方案汇报";
  const markdown = String(opts.synthesisMarkdown ?? "").trim();
  const plan = opts.synthesisPlan && typeof opts.synthesisPlan === "object" ? opts.synthesisPlan : null;
  const sections = parseMarkdownSections(markdown);
  const recipes = extractRecipeLines(markdown);
  const steps = collectProcessSteps(plan, markdown);
  const rows = Array.isArray(plan?.extractedData) ? plan.extractedData : [];
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: title, font: { name: FONT, eastAsia: CJK_FONT }, size: 36, bold: true, color: "1E3A5F" })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
      children: [new TextRun({ text: "由检索综述与结构化方案自动生成", font: { name: FONT, eastAsia: CJK_FONT }, size: 20, color: "64748B" })],
    }),
  ];

  for (const section of sections) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 280, after: 120 },
      children: [new TextRun({ text: section.head, font: { name: FONT, eastAsia: CJK_FONT }, size: 32, bold: true, color: BLUE })],
    }));
    for (const bullet of section.bullets) {
      children.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 80, line: 300 },
        children: [new TextRun({ text: bullet, font: { name: FONT, eastAsia: CJK_FONT }, size: 22, color: TEXT })],
      }));
    }
  }

  if (recipes.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "配方 / 组分摘录", font: { name: FONT, eastAsia: CJK_FONT }, size: 32, bold: true, color: BLUE })] }));
    for (const recipe of recipes) {
      children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: [new TextRun({ text: cleanInline(recipe), font: { name: FONT, eastAsia: CJK_FONT }, size: 22, color: TEXT })] }));
    }
  }

  if (steps.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "工序列表", font: { name: FONT, eastAsia: CJK_FONT }, size: 32, bold: true, color: BLUE })] }));
    children.push(buildTable(
      ["步骤", "动作", "输入", "输出", "备注"],
      steps.map((step, index) => [
        String(step.step_no ?? index + 1),
        cleanInline(step.action),
        cleanInline(step.inputs),
        cleanInline(step.outputs),
        cleanInline(step.note),
      ]),
      [760, 3800, 1700, 1700, 1400],
    ));
    children.push(paragraph("工艺流程图已按上述工序表结构化呈现。", { size: 18, color: "64748B", after: 180 }));
  }

  if (rows.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "关键数据与指标", font: { name: FONT, eastAsia: CJK_FONT }, size: 32, bold: true, color: BLUE })] }));
    children.push(buildTable(
      ["指标", "数值", "单位", "条件", "来源"],
      rows.slice(0, 120).map((row) => [
        cleanInline(row?.metric),
        cleanInline(row?.value),
        cleanInline(row?.unit),
        cleanInline(row?.condition),
        cleanInline(row?.source_ref),
      ]),
      [2200, 1500, 1100, 3300, 1260],
    ));
  }

  if (!sections.length && !recipes.length && !steps.length && !rows.length) {
    children.push(paragraph("暂无可用结构化内容，请先生成含配方或工序的综述后再导出。"));
  }

  const doc = new Document({
    creator: "犀材",
    title,
    styles: {
      default: {
        document: {
          run: { font: FONT, eastAsia: CJK_FONT, size: 22, color: TEXT },
          paragraph: { spacing: { after: 120, line: 300 } },
        },
      },
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [paragraph("犀材 · 方案汇报", { size: 18, color: "64748B", after: 0 })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "由检索综述与结构化方案自动生成", font: { name: FONT, eastAsia: CJK_FONT }, size: 16, color: "94A3B8" })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}
