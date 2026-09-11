/**
 * 从综述 / 联网回答中剥离末尾 JSON，并规范化「关键数据」字段 extractedData。
 */

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
export function normalizeExtractedData(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const metric = String(row.metric ?? row.name ?? row.label ?? "").trim();
    const value = String(row.value ?? row.val ?? "").trim();
    if (!metric && !value) continue;
    out.push({
      metric: metric || "（未命名指标）",
      value: value || "—",
      ...(String(row.unit ?? "").trim() ? { unit: String(row.unit).trim() } : {}),
      ...(String(row.condition ?? row.conditions ?? "").trim()
        ? { condition: String(row.condition ?? row.conditions).trim().slice(0, 200) }
        : {}),
      ...(String(row.source_ref ?? row.ref ?? row.source ?? "").trim()
        ? { source_ref: String(row.source_ref ?? row.ref ?? row.source).trim().slice(0, 80) }
        : {}),
      ...(String(row.context ?? row.note ?? "").trim()
        ? { context: String(row.context ?? row.note).trim().slice(0, 400) }
        : {}),
      ...(String(row.material ?? row.sample ?? "").trim()
        ? { material: String(row.material ?? row.sample).trim().slice(0, 120) }
        : {}),
    });
    if (out.length >= 80) break;
  }
  return out;
}

/**
 * @param {unknown} obj
 * @returns {Record<string, unknown> | null}
 */
export function normalizeSynthesisPlan(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = /** @type {Record<string, unknown>} */ (obj);
  const extractedData = normalizeExtractedData(
    o.extractedData ?? o.metrics ?? o.data_points ?? o.numeric_facts,
  );
  const steps = Array.isArray(o.steps) ? o.steps : [];
  return {
    ...o,
    extractedData,
    steps,
  };
}

function looksLikeStructuredPlan(text, start) {
  return /"(?:extractedData|steps)"\s*:/i.test(String(text).slice(start, start + 1200));
}

/** Find the end of a JSON object without being confused by braces in strings. */
function findJsonObjectEnd(text, start) {
  const source = String(text);
  if (source[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseStructuredObjectAt(text, start) {
  if (!looksLikeStructuredPlan(text, start)) return null;
  const end = findJsonObjectEnd(text, start);
  if (end < 0) return { end: -1, plan: null, parseError: true };
  try {
    const parsed = JSON.parse(String(text).slice(start, end));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!("steps" in parsed) && !("extractedData" in parsed)) return null;
    return { end, plan: normalizeSynthesisPlan(parsed), parseError: false };
  } catch {
    return { end, plan: null, parseError: true };
  }
}

function joinVisibleParts(before, after) {
  const left = String(before ?? "").trim();
  const right = String(after ?? "").trim();
  return [left, right].filter(Boolean).join("\n\n");
}

/**
 * @param {string} raw
 * @returns {{ markdown: string; plan: Record<string, unknown> | null; planNote: string }}
 */
export function parseSynthesisOutput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { markdown: "", plan: null, planNote: "synth_plan:empty" };

  // Providers may place the footer in a fenced block, omit the closing fence,
  // or append a short note after it. Detect the structured object first so the
  // machine section cannot leak into the user-visible markdown.
  const fenceRe = /```[ \t]*(?:json[ \t]*)?(?:\r?\n|$)/gi;
  let fm;
  while ((fm = fenceRe.exec(text))) {
    const contentStart = fm.index + fm[0].length;
    const objectOffset = text.slice(contentStart, contentStart + 1200).search(/\{/);
    if (objectOffset < 0) continue;
    const start = contentStart + objectOffset;
    const parsed = parseStructuredObjectAt(text, start);
    if (!parsed) continue;
    const closeMatch = parsed.end >= 0
      ? text.slice(parsed.end).match(/^\s*```/)
      : null;
    const close = closeMatch ? parsed.end + closeMatch[0].length : -1;
    const after = close >= 0 ? text.slice(close) : "";
    const markdown = joinVisibleParts(text.slice(0, fm.index), after);
    if (parsed.plan) {
      return {
        markdown,
        plan: parsed.plan,
        planNote: parsed.plan.extractedData?.length ? "synth_plan:ok" : "synth_plan:ok_no_data",
      };
    }
    return { markdown, plan: null, planNote: "synth_plan:parse_error" };
  }

  const candidateStarts = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{" && (i === 0 || /\s/.test(text[i - 1]))) candidateStarts.push(i);
  }
  for (const start of candidateStarts) {
    const parsed = parseStructuredObjectAt(text, start);
    if (!parsed) continue;
    const after = parsed.end >= 0
      ? text.slice(parsed.end).replace(/^\s*```/, "")
      : "";
    const markdown = joinVisibleParts(text.slice(0, start), after);
    if (parsed.plan) {
      return {
        markdown,
        plan: parsed.plan,
        planNote: parsed.plan.extractedData?.length ? "synth_plan:ok_inline" : "synth_plan:ok_inline_no_data",
      };
    }
    return { markdown, plan: null, planNote: "synth_plan:parse_error" };
  }

  return { markdown: text, plan: null, planNote: "synth_plan:no_json_block" };
}

/** 文献综述：正文须含数据表 + 文末 JSON */
export const SYNTH_MARKDOWN_DATA_SECTION =
  "\n\n## 关键数据与指标\n" +
  "若摘录中出现**任何可量化信息**（效率、产率、浓度、温度、压力、尺寸、产能、价格、占比、带隙、模量、电导率、寿命、速率、年份对比等），必须用 **Markdown 表格**列出，列至少包含：**指标** | **数值** | **单位** | **条件/样品** | **来源**（[n] 或 DOI/专利号）。\n" +
  "摘录中**每一个不同数值**都应在表中占一行；无数字则写一句「摘录未给出可核对数值」。**禁止编造**摘录中不存在的数字。\n";

/** 联网问答：同上，来源用 [n] */
export const WEB_MARKDOWN_DATA_SECTION =
  "\n\n## 关键数据与指标\n" +
  "若摘录中有**任何数字/百分比/范围/产能/成分含量/性能指标**，必须用 **Markdown 表格**列出：**指标** | **数值** | **单位** | **条件** | **来源[n]**。\n" +
  "摘录里出现的数值**不得遗漏**；无则写「摘录未给出可核对数值」。禁止编造。\n";

export const SYNTH_JSON_FOOTER =
  "\n\n【结构化 JSON（强制，放在全文最末）】\n" +
  "正文与表格写完后，**单独**输出一个 ```json 代码块```（勿穿插在段落中），内容为单个对象：\n" +
  '- **extractedData**（数组，必填）：摘录中出现的每个可量化指标一条；字段 metric（指标名）、value（数值原文）、unit（单位，可空）、condition（条件/样品，可空）、source_ref（如 "[3]" 或 DOI）、context（原文短句，可空）。与「关键数据与指标」表一致。\n' +
  "- **steps**（数组）：涉及**配方、工艺、工序、制备、烧结、混料**等时**必填** { step_no, action, inputs?, outputs? }，按时间顺序；无工序则 [].\n" +
  "无数字时 extractedData 为 []。只输出合法 JSON，不要用 metrics/data 等其它顶层键名替代 extractedData。\n";

export const WEB_JSON_FOOTER =
  "\n\n【结构化 JSON（强制，全文最末）】\n" +
  "单独输出 ```json 代码块```，对象含 **extractedData**（同上，source_ref 用 [n]）与 **steps**（工艺/配方相关时按先后填写，无工序则 []）。与上文「工序流程」小节一致。\n";

/**
 * @param {string | null | undefined} markdown
 * @returns {{ markdown: string | null; plan: Record<string, unknown> | null; planNote: string | null }}
 */
export function finalizeSynthesisMarkdown(markdown) {
  const md = String(markdown ?? "").trim();
  if (!md) return { markdown: null, plan: null, planNote: null };
  const parsed = parseSynthesisOutput(md);
  return {
    markdown: parsed.markdown || null,
    plan: parsed.plan,
    planNote: parsed.planNote,
  };
}
