/**
 * 按预设类型从文献摘录 + 综述抽取结构化数据表。
 */
import { normalizeExtractedData } from "./synthesisExtract.js";
import { resolvePrimaryProvider } from "./llmProviders.js";
import { generateText } from "./llmClient.js";

/** @type {Record<string, { label: string; title: string; focus: string }>} */
export const DATA_TABLE_TYPES = {
  performance: {
    label: "性能指标",
    title: "性能指标对比表",
    focus:
      "提取效率、转化率、产率、容量、能量/功率密度、PCE、选择性、循环寿命、降解率、吸附量、分离因子、催化活性等**性能类**数值；每条须可追溯来源 [n] 或 DOI。",
  },
  composition: {
    label: "组分配方",
    title: "材料组分配方表",
    focus:
      "提取化学组成、元素配比、摩尔比、质量分数(wt%)、体积分数、前驱体用量、添加剂、溶剂、掺杂浓度等**配方/组分**信息。",
  },
  process: {
    label: "工艺参数",
    title: "制备工艺参数表",
    focus:
      "提取合成/制备/处理工艺中的温度、压力、时间、升温速率、pH、转速、气氛、退火/烧结制度、涂布参数等**工艺条件**。",
  },
  structure: {
    label: "结构形貌",
    title: "结构与形貌参数表",
    focus:
      "提取粒径、晶粒尺寸、膜厚、孔径、比表面积、层间距、结晶度、相组成比例、形貌特征尺寸等**结构/形貌**参数。",
  },
  comparison: {
    label: "样品对比",
    title: "样品/文献横向对比表",
    focus:
      "按**样品名或文献**横向对比关键指标；metric 列写指标名，condition/material 列写样品或材料名称，source_ref 写 [n] 或 DOI；便于一眼比较不同来源数据。",
  },
};

/**
 * @param {unknown} p
 * @param {number} idx
 */
function paperExcerptBlock(p, idx) {
  if (!p || typeof p !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (p);
  const title = String(o.title ?? "").slice(0, 200);
  const summary = String(o.summary ?? o.abstract ?? "").slice(0, 2800);
  const src = String(o.source ?? "");
  const doi = String(o.doi ?? "").trim();
  const url = String(o.absUrl ?? "").trim();
  const id = doi ? `DOI: ${doi}` : url ? `URL: ${url.slice(0, 200)}` : `来源: ${src || "文献"}`;
  return `[${idx}] ${id}\n标题: ${title}\n摘录:\n${summary}`;
}

/**
 * @param {{ tableType: string; papers: unknown[]; synthesisMarkdown?: string; apiKey?: string; model?: string; chatCompletionsUrl?: string }} opts
 */
export async function extractDataTableByType(opts) {
  const tableType = String(opts.tableType ?? "").trim();
  const preset = DATA_TABLE_TYPES[tableType];
  if (!preset) {
    return { ok: false, error: `未知表类型: ${tableType}`, rows: [], title: "" };
  }

  const provider = resolvePrimaryProvider(opts);
  if (!provider) {
    return { ok: false, error: "未配置 LLM API Key", rows: [], title: preset.title };
  }

  const papers = (Array.isArray(opts.papers) ? opts.papers : []).slice(0, 40);
  const excerpts = papers.map((p, i) => paperExcerptBlock(p, i + 1)).filter(Boolean).join("\n\n---\n\n");
  if (!excerpts) {
    return { ok: false, error: "没有可用文献摘录", rows: [], title: preset.title };
  }

  const syn = String(opts.synthesisMarkdown ?? "").trim().slice(0, 8000);

  const system =
    "你是材料/化学领域的数据整理助手。根据用户指定的「表类型」，从文献摘录与综述中抽取**仅摘录中明确出现**的数值与事实，输出结构化表格行。\n" +
    "严格要求：\n" +
    "1) **禁止编造**；无数据则 rows 返回空数组。\n" +
    "2) 每行字段：metric（指标名）、value（数值或范围原文）、unit（单位，可空）、condition（测试/制备条件）、source_ref（[n] 或 DOI，n 与摘录序号一致）、material（样品/材料名，可选）。\n" +
    "3) 去重：完全相同指标+数值+来源只保留一行。\n" +
    "4) **只输出一个 JSON 对象**，禁止 markdown 围栏。\n" +
    'JSON: { "title": string, "rows": [ { "metric", "value", "unit?", "condition?", "source_ref?", "material?" } ] }';

  const user =
    `【表类型】${preset.label}\n【抽取重点】${preset.focus}\n\n` +
    (syn ? `---- 综述（可参考其中表格与引用编号）----\n${syn}\n\n` : "") +
    `---- 文献摘录（[1] 为第一条）----\n${excerpts}`;

  const ms = Math.min(120_000, Math.max(25_000, Number(process.env.SYNTHESIS_TIMEOUT_MS) || 90_000));

  try {
    const result = await generateText(provider, {
      timeoutMs: ms,
      temperature: 0.08,
      maxTokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
    });
    if (!result.ok) {
      return { ok: false, error: result.errorBody || result.error, rows: [], title: preset.title };
    }
    const content = result.text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { ok: false, error: "模型未返回有效 JSON", rows: [], title: preset.title };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const rows = normalizeExtractedData(parsed.rows ?? parsed.extractedData ?? parsed.data);
    const title = String(parsed.title ?? preset.title).trim().slice(0, 120) || preset.title;
    return {
      ok: true,
      tableType,
      title,
      rows,
      note: rows.length ? `data_table:ok|type=${tableType}|n=${rows.length}` : `data_table:empty|type=${tableType}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e).slice(0, 200),
      rows: [],
      title: preset.title,
    };
  }
}
