/**
 * 服务器 PDF 库元数据提取：复用正文解析阶段已抽取的全文，
 * 调用项目已有的 LLM 基础设施（resolvePrimaryProvider + generateText），
 * 提取 symmetry_phase / synthesis_method / structure_descriptor / properties 四个字段。
 */
import { resolvePrimaryProvider } from "./llmProviders.js";
import { generateText } from "./llmClient.js";

export const SERVER_PDF_META_FIELDS = Object.freeze([
  "symmetry_phase",
  "synthesis_method",
  "structure_descriptor",
  "properties",
]);

const DEFAULT_HEAD_CHARS = 16_000;
const DEFAULT_TAIL_CHARS = 8_000;
const MAX_FIELD_CHARS = 500;

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
    symmetry_phase: null,
    synthesis_method: null,
    structure_descriptor: null,
    properties: null,
  };
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
  const cleaned = String(text ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, data, error: "json_parse" };
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false, data, error: "json_parse" };
  }
  for (const key of SERVER_PDF_META_FIELDS) {
    const raw = String(parsed?.[key] ?? "");
    const normalized = raw.replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_CHARS);
    data[key] = normalized || null;
  }
  return { ok: true, data };
}

/**
 * 构造提示词并调用 LLM 提取四个字段。
 *
 * @param {{ provider?: object; title?: string; doi?: string; text?: string }} p
 * @returns {Promise<{ ok: boolean; data?: Record<string, string | null>; error?: string }>}
 */
export async function extractServerPdfMeta(p = {}) {
  const provider = p.provider || resolvePrimaryProvider();
  if (!provider) return { ok: false, error: "no-llm-key" };

  const title = String(p.title ?? "").trim().slice(0, 400);
  const doi = String(p.doi ?? "").trim().slice(0, 200);
  const window = serverPdfMetaWindow(p.text);
  if (!window) return { ok: false, error: "empty_text" };

  const system =
    "你是材料科学文献信息抽取助手。从给定论文正文中抽取以下四个字段，只抽取正文中明确出现的信息，禁止编造：\n" +
    "- symmetry_phase（对称相/晶体结构，如 \"立方相, cubic, Fm-3m\"）\n" +
    "- synthesis_method（合成/制备方法，如 \"溶胶-凝胶法, sol-gel, 高温固相烧结\"）\n" +
    "- structure_descriptor（结构描述符，如 \"层状结构, nanosheet, 多孔\"）\n" +
    "- properties（材料属性/性能，如 \"高离子电导率, high ionic conductivity\"）\n\n" +
    "每个字段输出简洁的中英关键词短语，用逗号分隔，不超过 300 字；正文未明确提到某字段时输出 null。\n" +
    '只输出一个合法 JSON 对象，不要用 markdown 围栏：{"symmetry_phase": string|null, "synthesis_method": string|null, "structure_descriptor": string|null, "properties": string|null}';

  const user =
    `论文标题：${title || "（未知）"}\n` +
    `DOI：${doi || "（未知）"}\n\n` +
    `正文摘录：\n${window}`;

  const timeoutMs = Math.min(
    360_000,
    Math.max(10_000, Number(process.env.PDF_META_TIMEOUT_MS) || 120_000),
  );
  const result = await generateText(provider, {
    timeoutMs,
    temperature: 0.1,
    maxTokens: 600,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (!result.ok) {
    return { ok: false, error: String(result.errorBody || result.error).slice(0, 300) };
  }
  const parsed = parseServerPdfMetaJson(result.text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, data: parsed.data };
}
