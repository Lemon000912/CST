/**
 * 将综述 + 工序/配方结构化为 PPTX（pptxgenjs）。
 */
import PptxGenJS from "pptxgenjs";
import { collectProcessSteps, extractRecipeLines } from "./processArtifacts.js";

const FONT = "Microsoft YaHei";
const SLIDE_W = 10;
const SLIDE_H = 5.625;
const HEADER_H = 0.72;
const CONTENT_TOP = 1.05;
const CONTENT_H = SLIDE_H - CONTENT_TOP - 0.35;
const BULLETS_PER_SLIDE = 6;
const STEPS_PER_FLOW_SLIDE = 5;
const STEPS_PER_TABLE_SLIDE = 10;
const RECIPES_PER_SLIDE = 8;

const THEME = {
  headerBg: "1E3A5F",
  headerText: "FFFFFF",
  slideBg: "F8FAFC",
  title: "1E293B",
  body: "334155",
  muted: "64748B",
  accent: "5C7A94",
  tableHead: "E2E8F0",
  border: "CBD5E1",
};

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string} s
 * @returns {string}
 */
function cleanMdInline(s) {
  return String(s ?? "")
    .replace(/\*\*/g, "")
    .replace(/\*(?!\*)/g, "")
    .replace(/`+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} md
 * @returns {{ head: string; bullets: string[] }[]}
 */
function parseMarkdownSections(md, maxSections = 14) {
  const text = String(md ?? "").trim();
  if (!text) return [];

  const sections = [];
  const parts = text.split(/\n(?=#{1,3}\s)/);

  for (const part of parts) {
    const lines = part
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    const head = cleanMdInline(lines[0].replace(/^#+\s*/, "")).slice(0, 60);
    const bullets = [];

    for (const line of lines.slice(1)) {
      if (line.startsWith("|") || line.startsWith("```")) continue;
      const list =
        line.match(/^[-*•]\s+(.+)/)?.[1] ??
        line.match(/^\d+[.、．):：]\s+(.+)/)?.[1] ??
        null;
      if (list) {
        bullets.push(cleanMdInline(list).slice(0, 220));
        continue;
      }
      if (!line.startsWith("#") && line.length >= 6) {
        bullets.push(cleanMdInline(line).slice(0, 220));
      }
    }

    if (!head) continue;
    if (!bullets.length) {
      const body = cleanMdInline(lines.slice(1).join(" ")).slice(0, 480);
      if (body) bullets.push(body);
    }
    if (bullets.length) sections.push({ head, bullets });
    if (sections.length >= maxSections) break;
  }

  if (!sections.length) {
    const plain = cleanMdInline(text.replace(/^#+\s*/gm, "")).slice(0, 600);
    if (plain) {
      const paras = plain.split(/(?<=[。；;！!？?])\s+/).filter((p) => p.length >= 4);
      sections.push({
        head: "方案摘要",
        bullets: (paras.length ? paras : [plain]).slice(0, 8).map((p) => p.slice(0, 220)),
      });
    }
  }

  return sections;
}

/**
 * @param {PptxGenJS} pptx
 */
function definePresentationMaster(pptx) {
  pptx.defineSlideMaster({
    title: "QP_MASTER",
    background: { color: THEME.slideBg },
    slideNumber: { x: 9.15, y: 5.28, fontFace: FONT, fontSize: 9, color: THEME.muted },
    objects: [
      {
        rect: {
          x: 0,
          y: 0,
          w: SLIDE_W,
          h: HEADER_H,
          fill: { color: THEME.headerBg },
        },
      },
    ],
  });
}

/**
 * @param {PptxGenJS} pptx
 * @param {string} slideTitle
 * @param {string} [subtitle]
 */
function addContentSlideShell(pptx, slideTitle, subtitle) {
  const slide = pptx.addSlide({ masterName: "QP_MASTER" });
  slide.addText(slideTitle, {
    x: 0.55,
    y: 0.12,
    w: 8.8,
    h: 0.48,
    fontFace: FONT,
    fontSize: 22,
    bold: true,
    color: THEME.headerText,
    valign: "middle",
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.55,
      y: 0.52,
      w: 8.8,
      h: 0.18,
      fontFace: FONT,
      fontSize: 10,
      color: "CBD5E1",
    });
  }
  return slide;
}

/**
 * @param {import("pptxgenjs").default} pptx
 * @param {string} title
 * @param {string} subtitle
 */
function addCoverSlide(pptx, title, subtitle) {
  const slide = pptx.addSlide();
  slide.background = { color: THEME.headerBg };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 3.85,
    w: SLIDE_W,
    h: 1.775,
    fill: { color: THEME.slideBg },
  });
  slide.addText(title, {
    x: 0.75,
    y: 1.35,
    w: 8.5,
    h: 1.5,
    fontFace: FONT,
    fontSize: 34,
    bold: true,
    color: THEME.headerText,
    valign: "middle",
  });
  slide.addText(subtitle, {
    x: 0.75,
    y: 2.85,
    w: 8.5,
    h: 0.55,
    fontFace: FONT,
    fontSize: 14,
    color: "CBD5E1",
  });
  slide.addText(new Date().toLocaleDateString("zh-CN"), {
    x: 0.75,
    y: 4.15,
    w: 4,
    h: 0.35,
    fontFace: FONT,
    fontSize: 11,
    color: THEME.muted,
  });
}

/**
 * @param {import("pptxgenjs").default} pptx
 * @param {string} slideTitle
 * @param {string[]} bullets
 * @param {{ page?: number; total?: number; section?: string }} [meta]
 */
function addBulletSlides(pptx, slideTitle, bullets, meta = {}) {
  if (!bullets.length) return;
  const pages = chunkArray(bullets, BULLETS_PER_SLIDE);
  pages.forEach((pageBullets, idx) => {
    const suffix =
      pages.length > 1 ? `（${idx + 1}/${pages.length}）` : meta.page ? `（${meta.page}/${meta.total}）` : "";
    const subtitle = meta.section && idx === 0 ? meta.section : undefined;
    const slide = addContentSlideShell(pptx, `${slideTitle}${suffix}`, subtitle);
    slide.addText(
      pageBullets.map((b) => ({
        text: b,
        options: {
          bullet: true,
          breakLine: true,
          fontSize: 14,
          fontFace: FONT,
          color: THEME.body,
          paraSpaceAfter: 6,
        },
      })),
      {
        x: 0.6,
        y: CONTENT_TOP,
        w: 8.85,
        h: CONTENT_H,
        valign: "top",
        lineSpacingMultiple: 1.15,
      },
    );
  });
}

/**
 * @param {import("pptxgenjs").default} pptx
 * @param {ReturnType<typeof collectProcessSteps>} steps
 */
function addProcessTableSlides(pptx, steps) {
  if (!steps.length) return;
  const pages = chunkArray(steps, STEPS_PER_TABLE_SLIDE);
  pages.forEach((pageSteps, pageIdx) => {
    const title = pages.length > 1 ? `工艺流程明细（${pageIdx + 1}/${pages.length}）` : "工艺流程明细";
    const slide = addContentSlideShell(pptx, title);
    const tableRows = [
      [
        { text: "序号", options: { bold: true, fill: THEME.tableHead, fontFace: FONT, fontSize: 11 } },
        { text: "工序", options: { bold: true, fill: THEME.tableHead, fontFace: FONT, fontSize: 11 } },
        { text: "投入", options: { bold: true, fill: THEME.tableHead, fontFace: FONT, fontSize: 11 } },
        { text: "产出 / 备注", options: { bold: true, fill: THEME.tableHead, fontFace: FONT, fontSize: 11 } },
      ],
    ];
    for (const s of pageSteps) {
      const inputs = Array.isArray(s.inputs) ? s.inputs.join("；") : String(s.inputs ?? "—");
      const outputs = [s.outputs, s.note].filter(Boolean).map(String).join("；") || "—";
      tableRows.push([
        { text: String(s.step_no ?? "—"), options: { fontFace: FONT, fontSize: 11, align: "center" } },
        { text: String(s.action ?? "—").slice(0, 120), options: { fontFace: FONT, fontSize: 11 } },
        { text: inputs.slice(0, 80), options: { fontFace: FONT, fontSize: 10, color: THEME.muted } },
        { text: outputs.slice(0, 80), options: { fontFace: FONT, fontSize: 10, color: THEME.muted } },
      ]);
    }
    slide.addTable(tableRows, {
      x: 0.45,
      y: CONTENT_TOP,
      w: 9.1,
      colW: [0.55, 3.35, 2.5, 2.7],
      fontSize: 11,
      fontFace: FONT,
      border: { type: "solid", color: THEME.border, pt: 0.5 },
      autoPage: false,
      valign: "middle",
    });
  });
}

/**
 * @param {import("pptxgenjs").default} pptx
 * @param {ReturnType<typeof collectProcessSteps>} steps
 */
function addNativeFlowSlides(pptx, steps) {
  if (!steps.length) return;
  const pages = chunkArray(steps, STEPS_PER_FLOW_SLIDE);
  pages.forEach((pageSteps, pageIdx) => {
    const title = pages.length > 1 ? `工艺流程图（${pageIdx + 1}/${pages.length}）` : "工艺流程图";
    const slide = addContentSlideShell(pptx, title);

    const boxW = 7.6;
    const boxH = 0.72;
    const gap = 0.28;
    const x = (SLIDE_W - boxW) / 2;
    let y = CONTENT_TOP;

    pageSteps.forEach((s, i) => {
      if (i > 0) {
        slide.addShape(pptx.ShapeType.line, {
          x: x + boxW / 2,
          y: y - gap,
          w: 0,
          h: gap,
          line: { color: THEME.accent, width: 1.5, endArrowType: "triangle", endArrowSize: 4 },
        });
      }

      slide.addShape(pptx.ShapeType.roundRect, {
        x,
        y,
        w: boxW,
        h: boxH,
        fill: { color: "FFFFFF" },
        line: { color: THEME.accent, width: 1.25 },
        rectRadius: 0.06,
      });

      const label = `${s.step_no ?? i + 1}. ${String(s.action ?? "").slice(0, 100)}`;
      slide.addText(label, {
        x: x + 0.18,
        y: y + 0.1,
        w: boxW - 0.36,
        h: 0.34,
        fontFace: FONT,
        fontSize: 13,
        bold: true,
        color: THEME.title,
        valign: "middle",
      });

      const sub = [
        s.inputs ? `投入：${Array.isArray(s.inputs) ? s.inputs.join("；") : s.inputs}` : "",
        s.outputs ? `产出：${Array.isArray(s.outputs) ? s.outputs.join("；") : s.outputs}` : "",
      ]
        .filter(Boolean)
        .join("  ·  ")
        .slice(0, 140);

      if (sub) {
        slide.addText(sub, {
          x: x + 0.18,
          y: y + 0.42,
          w: boxW - 0.36,
          h: 0.24,
          fontFace: FONT,
          fontSize: 10,
          color: THEME.muted,
        });
      }

      y += boxH + gap + (sub ? 0.08 : 0);
    });
  });
}

/**
 * @param {import("pptxgenjs").default} pptx
 * @param {string[]} recipes
 */
function addRecipeSlides(pptx, recipes) {
  if (!recipes.length) return;
  const pages = chunkArray(recipes, RECIPES_PER_SLIDE);
  pages.forEach((pageRecipes, idx) => {
    const title = pages.length > 1 ? `配方 / 组分（${idx + 1}/${pages.length}）` : "配方 / 组分";
    addBulletSlides(
      pptx,
      title,
      pageRecipes.map((r) => cleanMdInline(r).slice(0, 200)),
    );
  });
}

/**
 * @param {import("pptxgenjs").default} pptx
 * @param {unknown[]} rows
 */
function addDataTableSlides(pptx, rows) {
  if (!rows.length) return;
  const pages = chunkArray(rows, 12);
  pages.forEach((pageRows, pageIdx) => {
    const title = pages.length > 1 ? `关键数据与指标（${pageIdx + 1}/${pages.length}）` : "关键数据与指标";
    const slide = addContentSlideShell(pptx, title);
    const tableRows = [
      [
        { text: "指标", options: { bold: true, fill: THEME.tableHead, fontFace: FONT } },
        { text: "数值", options: { bold: true, fill: THEME.tableHead, fontFace: FONT } },
        { text: "单位", options: { bold: true, fill: THEME.tableHead, fontFace: FONT } },
        { text: "条件 / 材料", options: { bold: true, fill: THEME.tableHead, fontFace: FONT } },
      ],
    ];
    for (const r of pageRows) {
      if (!r || typeof r !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (r);
      tableRows.push([
        { text: String(o.metric ?? "—").slice(0, 36), options: { fontFace: FONT, fontSize: 11 } },
        { text: String(o.value ?? "—").slice(0, 28), options: { fontFace: FONT, fontSize: 11 } },
        { text: String(o.unit ?? "—").slice(0, 14), options: { fontFace: FONT, fontSize: 11 } },
        {
          text: String(o.condition ?? o.material ?? "—").slice(0, 32),
          options: { fontFace: FONT, fontSize: 10, color: THEME.muted },
        },
      ]);
    }
    slide.addTable(tableRows, {
      x: 0.45,
      y: CONTENT_TOP,
      w: 9.1,
      colW: [2.6, 2.2, 1.2, 3.1],
      fontSize: 11,
      fontFace: FONT,
      border: { type: "solid", color: THEME.border, pt: 0.5 },
      autoPage: false,
      valign: "middle",
    });
  });
}

/**
 * @param {{ title?: string; synthesisMarkdown?: string; synthesisPlan?: Record<string, unknown> | null; flowchartSvgBase64?: string | null }} opts
 * @returns {Promise<Buffer>}
 */
export async function buildPptxBuffer(opts) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "犀材";
  const title = String(opts.title ?? "方案汇报").trim().slice(0, 120) || "方案汇报";
  pptx.title = title;

  definePresentationMaster(pptx);

  const md = String(opts.synthesisMarkdown ?? "").trim();
  const plan = opts.synthesisPlan ?? null;
  const steps = collectProcessSteps(plan, md);
  const recipes = extractRecipeLines(md);
  const sections = parseMarkdownSections(md);

  addCoverSlide(pptx, title, "由检索综述与结构化方案自动生成");

  if (sections.length) {
    sections.forEach((sec, idx) => {
      addBulletSlides(pptx, sec.head || "方案要点", sec.bullets, {
        page: idx + 1,
        total: sections.length,
        section: sec.head,
      });
    });
  }

  if (recipes.length) addRecipeSlides(pptx, recipes);
  if (steps.length) {
    addNativeFlowSlides(pptx, steps);
    addProcessTableSlides(pptx, steps);
  }

  const rows = Array.isArray(plan?.extractedData) ? plan.extractedData : [];
  if (rows.length) addDataTableSlides(pptx, rows);

  if (!sections.length && !recipes.length && !steps.length && !rows.length) {
    addBulletSlides(pptx, "说明", ["暂无可用结构化内容，请先生成含配方或工序的综述后再导出。"]);
  }

  const buf = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(buf);
}
