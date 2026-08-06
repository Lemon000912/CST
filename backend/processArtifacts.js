/**
 * 从综述 / synthesisPlan 提取工序与配方，生成 Mermaid 流程图与简易 SVG。
 */

/** @typedef {{ step_no?: number|string; action: string; inputs?: string|string[]; outputs?: string|string[]; note?: string }} ProcessStep */

const PROCESS_SECTION_RE =
  /(?:^|\n)#+\s*[^\n]*(?:工序流程|工艺流程|制备流程|合成工艺|工艺路线|实验步骤|SOP|配方)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|\n----|\s*$)/gi;

const NUMBERED_LINE_RE = /^\s*(\d{1,2})[.、．):：]\s*(.+?)\s*$/;
const BULLET_LINE_RE = /^\s*[-*•]\s+(.+?)\s*$/;

const PROCESS_KEYWORDS =
  /配方|工艺|工序|制备|烧结|退火|掺杂|涂布|混料|球磨|压片|纺丝|聚合|水解|干燥|煅烧|萃取|提纯|镀膜|CVD|PVD|溶胶|凝胶|前驱体|摩尔比|wt%|mol%|质量分数/i;

/**
 * @param {unknown} v
 * @returns {string}
 */
function formatInOut(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean).join("；");
  return String(v).trim();
}

/**
 * @param {unknown} row
 * @param {number} idx
 * @returns {ProcessStep | null}
 */
export function normalizeProcessStep(row, idx) {
  if (!row || typeof row !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (row);
  const action = String(o.action ?? o.name ?? o.step_name ?? o.title ?? o.description ?? "").trim();
  if (!action) return null;
  const step_no = o.step_no ?? o.step ?? o.no ?? idx + 1;
  return {
    step_no,
    action: action.slice(0, 500),
    ...(formatInOut(o.inputs) ? { inputs: formatInOut(o.inputs).slice(0, 400) } : {}),
    ...(formatInOut(o.outputs) ? { outputs: formatInOut(o.outputs).slice(0, 400) } : {}),
    ...(String(o.note ?? o.remark ?? "").trim()
      ? { note: String(o.note ?? o.remark).trim().slice(0, 300) }
      : {}),
  };
}

/**
 * @param {string} md
 * @returns {ProcessStep[]}
 */
export function extractStepsFromMarkdown(md) {
  const text = String(md ?? "");
  if (!text.trim()) return [];
  const steps = [];
  const seen = new Set();

  const pushLine = (action, stepNo) => {
    const a = String(action ?? "").trim();
    if (!a || a.length < 2) return;
    const key = a.slice(0, 120);
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ step_no: stepNo ?? steps.length + 1, action: a.slice(0, 500) });
  };

  let m;
  PROCESS_SECTION_RE.lastIndex = 0;
  while ((m = PROCESS_SECTION_RE.exec(text)) !== null) {
    const block = m[1] || "";
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("|") || t.startsWith("```")) continue;
      const num = t.match(NUMBERED_LINE_RE);
      if (num) {
        pushLine(num[2], Number(num[1]) || undefined);
        continue;
      }
      const bul = t.match(BULLET_LINE_RE);
      if (bul) pushLine(bul[1]);
    }
  }

  if (steps.length < 2) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      const num = t.match(NUMBERED_LINE_RE);
      if (num && PROCESS_KEYWORDS.test(num[2])) pushLine(num[2], Number(num[1]) || undefined);
    }
  }

  return steps.slice(0, 24);
}

/**
 * @param {string} md
 * @returns {string[]}
 */
export function extractRecipeLines(md) {
  const lines = [];
  for (const raw of String(md ?? "").split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    if (/配方|组分|摩尔比|质量比|wt%|mol%|前驱体|原料|成分/i.test(t) && t.length >= 4 && t.length <= 400) {
      lines.push(t);
    }
  }
  return [...new Set(lines)].slice(0, 12);
}

/**
 * @param {Record<string, unknown> | null | undefined} plan
 * @param {string} [markdown]
 * @returns {ProcessStep[]}
 */
export function collectProcessSteps(plan, markdown = "") {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s) return;
    const k = s.action.slice(0, 100);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };

  if (plan && Array.isArray(plan.steps)) {
    for (let i = 0; i < plan.steps.length; i++) {
      push(normalizeProcessStep(plan.steps[i], i));
    }
  }

  for (const s of extractStepsFromMarkdown(markdown)) push(s);

  return out.map((s, i) => ({ ...s, step_no: s.step_no ?? i + 1 })).slice(0, 24);
}

/**
 * @param {string} s
 */
function mermaidLabel(s) {
  return String(s ?? "")
    .replace(/"/g, "'")
    .replace(/[<>[\]{}|#]/g, " ")
    .replace(/\n/g, " ")
    .trim()
    .slice(0, 72);
}

/**
 * @param {ProcessStep[]} steps
 * @param {{ title?: string; recipeLines?: string[] }} [opts]
 * @returns {string}
 */
export function buildMermaidFlowchart(steps, opts = {}) {
  const list = (steps ?? []).filter((s) => s?.action);
  if (!list.length) return "";

  const lines = ["flowchart TD"];
  const title = String(opts.title ?? "工艺流程").trim();
  if (title) lines.push(`  subgraph main["${mermaidLabel(title)}"]`);

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const id = `S${i + 1}`;
    let label = `${s.step_no ?? i + 1}. ${s.action}`;
    const extra = [formatInOut(s.inputs), formatInOut(s.outputs)].filter(Boolean).join(" → ");
    if (extra) label += ` (${extra})`;
    lines.push(`    ${id}["${mermaidLabel(label)}"]`);
    if (i > 0) lines.push(`    S${i} --> ${id}`);
  }

  if (title) lines.push("  end");

  const recipes = opts.recipeLines ?? [];
  if (recipes.length) {
    lines.push(`  subgraph recipe["配方 / 组分"]`);
    lines.push(`    R0["${mermaidLabel(recipes[0])}"]`);
    for (let i = 1; i < recipes.length; i++) {
      lines.push(`    R${i}["${mermaidLabel(recipes[i])}"]`);
      lines.push(`    R${i - 1} --> R${i}`);
    }
    lines.push(`  end`);
    lines.push(`  recipe --> S1`);
  }

  return lines.join("\n");
}

/**
 * @param {ProcessStep[]} steps
 * @returns {string|null} base64 SVG（无步骤时 null）
 */
export function renderProcessFlowSvg(steps) {
  const list = (steps ?? []).filter((s) => s?.action);
  if (!list.length) return null;

  const boxW = 220;
  const boxH = 56;
  const gapY = 28;
  const pad = 24;
  const w = boxW + pad * 2;
  const h = pad * 2 + list.length * (boxH + gapY) - gapY;

  const esc = (t) =>
    String(t ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="100%" height="100%" fill="#f8fafc"/>`,
  ];

  for (let i = 0; i < list.length; i++) {
    const y = pad + i * (boxH + gapY);
    const x = pad;
    const s = list[i];
    const label = esc(`${s.step_no ?? i + 1}. ${s.action}`.slice(0, 48));
    parts.push(
      `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="8" fill="#fff" stroke="#334155" stroke-width="1.5"/>`,
      `<text x="${x + 12}" y="${y + 22}" font-family="sans-serif" font-size="12" fill="#0f172a">${label}</text>`,
    );
    const sub = [formatInOut(s.inputs), formatInOut(s.outputs)].filter(Boolean).join(" → ");
    if (sub) {
      parts.push(
        `<text x="${x + 12}" y="${y + 40}" font-family="sans-serif" font-size="10" fill="#64748b">${esc(sub.slice(0, 52))}</text>`,
      );
    }
    if (i > 0) {
      const ay1 = pad + (i - 1) * (boxH + gapY) + boxH;
      const ay2 = y;
      const cx = x + boxW / 2;
      parts.push(
        `<line x1="${cx}" y1="${ay1}" x2="${cx}" y2="${ay2 - 6}" stroke="#64748b" stroke-width="1.5" marker-end="url(#arrow)"/>`,
      );
    }
  }
  parts.push(
    `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#64748b"/></marker></defs>`,
  );
  parts.push("</svg>");
  return Buffer.from(parts.join(""), "utf8").toString("base64");
}

/**
 * @param {string} query
 * @param {Record<string, unknown> | null} plan
 * @param {string} markdown
 */
export function shouldBuildProcessFlowchart(query, plan, markdown) {
  const q = String(query ?? "");
  const md = String(markdown ?? "");
  if (PROCESS_KEYWORDS.test(q) || PROCESS_KEYWORDS.test(md)) return true;
  const steps = collectProcessSteps(plan, md);
  if (steps.length >= 2) return true;
  if (extractRecipeLines(md).length >= 2) return true;
  return false;
}

/**
 * @param {{ title?: string; query?: string; synthesisPlan?: Record<string, unknown> | null; synthesisMarkdown?: string }} input
 */
export function buildProcessArtifacts(input) {
  const markdown = String(input.synthesisMarkdown ?? "").trim();
  const plan = input.synthesisPlan ?? null;
  const title = String(input.title ?? input.query ?? "工艺流程").trim().slice(0, 120);
  const steps = collectProcessSteps(plan, markdown);
  const recipeLines = extractRecipeLines(markdown);

  if (!shouldBuildProcessFlowchart(input.query ?? "", plan, markdown) && steps.length < 2) {
    return {
      flowchart: null,
      note: "artifacts:no-process-content",
      stepCount: steps.length,
    };
  }

  const mermaid = buildMermaidFlowchart(steps.length ? steps : [{ step_no: 1, action: title || "工艺步骤待补充" }], {
    title,
    recipeLines,
  });

  const svgBase64 = steps.length ? renderProcessFlowSvg(steps) : null;

  return {
    flowchart: {
      mermaid,
      steps,
      recipeLines,
      svgBase64,
      title,
    },
    note: steps.length
      ? `artifacts:flowchart_ok|steps=${steps.length}`
      : `artifacts:flowchart_recipe_only|recipes=${recipeLines.length}`,
    stepCount: steps.length,
  };
}
