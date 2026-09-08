/**
 * 服务器 PDF 库元数据提取：复用正文解析阶段已抽取的全文，
 * 调用项目已有的 LLM 基础设施（resolvePrimaryProvider + generateText），
 * Provider A 抽取 PDF 首页元数据、全文性能指标和结论总结。
 */
import { resolvePrimaryProvider } from "./llmProviders.js";
import { generateText } from "./llmClient.js";

export const SERVER_PDF_META_FIELDS = Object.freeze([
  "symmetry_phase",
  "synthesis_method",
  "structure_descriptor",
  "properties",
]);
const ALL_META_FIELDS = Object.freeze([
  "title", "abstract", "keywords", "first_author", "summary",
  ...SERVER_PDF_META_FIELDS, "applications", "material_name", "characterization_method",
]);

const DEFAULT_HEAD_CHARS = 16_000;
const DEFAULT_TAIL_CHARS = 8_000;
const MAX_FIELD_CHARS = 500;
const MAX_LIST = 60;

function envInt(name, fallback) {
  const value = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * 取正文「前 headChars + 后 tailChars」窗口，避免整篇 12 万字符全送模型。
 * 短文本原样返回；可被 PDF_META_HEAD_CHARS / PDF_META_TAIL_CHARS 或 options 覆盖。
 *
 * @param {string} text
 * @param {{ headChars?: number; tailChars?: number }} [options]
 */
export function serverPdfMetaWindow(text, options = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  const headChars = Math.max(1_000, Number(options.headChars) || envInt("PDF_META_HEAD_CHARS", DEFAULT_HEAD_CHARS));
  const tailChars = Math.max(500, Number(options.tailChars) || envInt("PDF_META_TAIL_CHARS", DEFAULT_TAIL_CHARS));
  if (raw.length <= headChars + tailChars) return raw;
  return `${raw.slice(0, headChars)}\n\n...[中间正文已省略]...\n\n${raw.slice(-tailChars)}`;
}

function emptyMetaData() {
  return {
    title: null,
    abstract: null,
    keywords: [],
    first_author: null,
    summary: null,
    symmetry_phase: null,
    synthesis_method: null,
    structure_descriptor: null,
    properties: null,
    applications: null,
    material_name: null,
    characterization_method: null,
  };
}

function clean(value, limit = MAX_FIELD_CHARS) {
  const out = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  return out || null;
}

function normalizeProperties(value) {
  if (typeof value === "string") return clean(value);
  return (Array.isArray(value) ? value : []).slice(0, MAX_LIST).map((item) => {
    if (!item || typeof item !== "object") return null;
    return {
      material: clean(item.material, 300),
      synthesis_method: clean(item.synthesis_method, 300),
      property: clean(item.property, 300),
      value: item.value === undefined || item.value === null ? null : String(item.value).slice(0, 120),
      unit: clean(item.unit, 120),
      conditions: clean(item.conditions, 500),
      source: clean(item.source, 40),
      evidence: clean(item.evidence, 800),
    };
  }).filter((item) => item && item.property && (item.value || item.evidence));
}

/**
 * 解析模型输出的 JSON：剥离 markdown 围栏、取首个 `{...}`、字段截断到 500 字符、
 * 空白与空串归 null。非法输入返回 ok:false 且 data 全为 null。
 *
 * @param {string} text
 * @returns {{ ok: boolean; data: Record<string, string | null>; error?: string }}
 */
export function parseServerPdfMetaJson(text) {
  const data = emptyMetaData();
  const legacyData = () => Object.fromEntries(SERVER_PDF_META_FIELDS.map((key) => [key, data[key]]));
  const cleaned = String(text ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, data: legacyData(), error: "json_parse" };
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false, data: legacyData(), error: "json_parse" };
  }
  for (const key of ALL_META_FIELDS) {
    if (key === "properties") data[key] = normalizeProperties(parsed?.[key]);
    else if (key === "keywords" || key === "material_name") {
      const values = Array.isArray(parsed?.[key]) ? parsed[key] : String(parsed?.[key] ?? "").split(/[,;；、]/);
      data[key] = values.map((value) => clean(value, 240)).filter(Boolean).slice(0, 40);
    } else data[key] = clean(parsed?.[key]);
  }
  return { ok: true, data };
}

/**
 * 构造提示词并调用 LLM 提取七个字段。
 *
 * @param {{ provider?: object; title?: string; doi?: string; text?: string }} p
 * @returns {Promise<{ ok: boolean; data?: Record<string, string | null>; error?: string }>}
 */
function firstPageFallback(text) {
  const raw = String(text ?? "").trim();
  const page = raw.split(/\n\s*(?:\f|---\s*page\s*2|page\s*2\b)/i)[0] || raw;
  return page.slice(0, 18_000);
}

function performanceEvidence(text) {
  const paragraphs = String(text ?? "").split(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z])/);
  const metric = /\b(?:capacity|conductivity|strength|hardness|modulus|efficiency|retention|rate|性能|强度|电导率|容量|效率|稳定性|寿命|温度|\d+(?:\.\d+)?\s*(?:%|MPa|GPa|S\/cm|mS\/cm|mAh|K|°C|nm|μm|eV))\b/i;
  return paragraphs.filter((p) => metric.test(p)).map((p) => p.trim()).filter(Boolean).join("\n\n").slice(0, 45_000);
}

export function extractAbstractRule(text) {
  const page = firstPageFallback(text);
  const match = page.match(/(?:^|\n|\s)(?:abstract|摘要)\s*[:：\-—]?\s*([\s\S]*?)(?=\n?\s*(?:keywords?|关键词|introduction|1\.?\s*introduction|引言)\b|$)/i);
  return clean(match?.[1], 12_000);
}

export async function extractServerPdfMeta(p = {}) {
  const provider = p.provider || resolvePrimaryProvider();
  if (!provider) return { ok: false, error: "no-llm-key" };

  const title = String(p.title ?? "").trim().slice(0, 400);
  const doi = String(p.doi ?? "").trim().slice(0, 200);
  const fullText = String(p.fullText ?? p.text ?? "").trim();
  if (!fullText) return { ok: false, error: "empty_text" };
  const page = String(p.firstPage ?? firstPageFallback(fullText)).slice(0, 18_000);
  const abstractRule = extractAbstractRule(page);
  const conclusion = fullText.match(/(?:summary|conclusions?|结论|总结)\b[\s\S]{0,18_000}$/i)?.[0] || fullText.slice(-18_000);
  const evidence = performanceEvidence(fullText);

  const system =
    "你是材料科学论文入库抽取助手。只依据输入原文，不得编造。title、abstract、first_author、keywords、material_name 只从首页判断；material_name 只保留明确材料名或化学式。properties 必须是数组，每项包含 material,synthesis_method,property,value,unit,conditions,source,evidence；只保留原文明确出现的指标和值。summary 是对 Summary/Conclusion 的忠实中文总结。\n" +
    "输出字段：title, abstract, keywords, first_author, summary，以及原有材料字段。\n" +
    "- symmetry_phase（对称相/晶体结构，如 \"立方相, cubic, Fm-3m\"）\n" +
    "- synthesis_method（合成/制备方法，如 \"溶胶-凝胶法, sol-gel, 高温固相烧结\"）\n" +
    "- structure_descriptor（结构描述符，如 \"层状结构, nanosheet, 多孔\"）\n" +
    "- properties（材料属性/性能，如 \"高离子电导率, high ionic conductivity\"）\n" +
    "- applications（应用/用途，如 \"锂离子电池, lithium-ion battery, 催化\"）\n" +
    "- material_name（材料名称/化学式，如 \"LiFePO4, 钛酸钡, BaTiO3\"）\n" +
    "- characterization_method（表征/测试方法，如 \"XRD, 扫描电镜, SEM, 阻抗谱\"）\n\n" +
    '只输出一个合法 JSON 对象：{"title":string|null,"abstract":string|null,"keywords":string[],"first_author":string|null,"summary":string|null,"symmetry_phase":string|null,"synthesis_method":string|null,"structure_descriptor":string|null,"properties":array,"applications":string|null,"material_name":string[],"characterization_method":string|null}';

  const user =
    `论文标题：${title || "（未知）"}\n` +
    `DOI：${doi || "（未知）"}\n\n` +
    `首页：\n${page}\n\n规则抽取摘要（可修正）：${abstractRule || "null"}\n\n全文性能证据段落（从全文筛选，需逐条核对）：\n${evidence || serverPdfMetaWindow(fullText, { headChars: 24_000, tailChars: 24_000 })}\n\n结论候选：\n${conclusion}`;

  const timeoutMs = Math.min(
    360_000,
    Math.max(10_000, Number(process.env.PDF_META_TIMEOUT_MS) || 120_000),
  );
  const result = await generateText(provider, {
    timeoutMs,
    temperature: 0.1,
    maxTokens: 4_000,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (!result.ok) {
    return { ok: false, error: String(result.errorBody || result.error).slice(0, 300) };
  }
  const parsed = parseServerPdfMetaJson(result.text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.data.abstract && abstractRule) parsed.data.abstract = abstractRule;
  return { ok: true, data: parsed.data };
}
