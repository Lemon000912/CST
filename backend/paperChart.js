import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrimaryProvider } from "./llmProviders.js";
import { generateText } from "./llmClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = path.join(__dirname, "scripts", "render_paper_chart.py");

/** @param {unknown} p */
function paperSnippet(p) {
  if (!p || typeof p !== "object") return null;
  const doi = String(p.doi ?? "").trim();
  const ax = String(p.id ?? p.arxiv_id ?? "")
    .replace(/^arxiv:/i, "")
    .trim();
  const title = String(p.title ?? "").slice(0, 180);
  const maxSum = Math.min(4000, Math.max(420, Number(process.env.PAPER_CHART_SUMMARY_CHARS) || 2200));
  const summary = String(p.summary ?? p.abstract ?? "").slice(0, maxSum);
  const year = p.year != null ? Number(p.year) : null;
  const src = String(p.source ?? "");
  const absU = String(p.absUrl ?? "").trim();
  let idLine = "";
  if (doi) idLine = `DOI: ${doi}`;
  else if (ax) idLine = `arXiv: ${ax}`;
  else if (
    src === "mcp_web" ||
    src === "ddg_web" ||
    src === "dataify_web" ||
    src === "tavily_web" ||
    src === "searx_web" ||
    src === "qwant_web" ||
    src === "mojeek_web" ||
    src === "wikipedia_web" ||
    src === "core"
  ) {
    idLine = absU ? `URL: ${absU.slice(0, 200)}` : "网页文献";
  } else if (src === "openalex_patent") {
    const pid = String(p.paper_id ?? "").replace(/^openalex_patent:/i, "").trim();
    idLine = pid ? `专利(OpenAlex): ${pid}` : "专利文献";
  } else if (src === "ddg_patent") {
    idLine = absU ? `专利(Web): ${absU.slice(0, 200)}` : "专利文献";
  } else if (src === "scopus" && absU) {
    idLine = `Scopus: ${absU.slice(0, 200)}`;
  } else if (src === "europepmc") {
    idLine = absU ? `Europe PMC: ${absU.slice(0, 200)}` : "Europe PMC";
  } else if (src === "openalex") {
    idLine = absU ? `OpenAlex: ${absU.slice(0, 200)}` : "OpenAlex";
  } else if (src === "semantic_scholar") {
    idLine = absU ? `Semantic Scholar: ${absU.slice(0, 200)}` : "Semantic Scholar";
  } else if (absU) {
    idLine = `URL: ${absU.slice(0, 200)}`;
  } else {
    idLine = "（无标识符）";
  }
  return { idLine, title, year: Number.isFinite(year) ? year : null, summary };
}

/**
 * @param {unknown[]} papers
 * @param {{ apiKey?: string; model?: string; chatCompletionsUrl?: string; userHint?: string; synthesisMarkdown?: string }} opts
 */
export async function extractChartSpecWithLlm(papers, opts) {
  const provider = resolvePrimaryProvider(opts);
  if (!provider) {
    return { ok: false, error: "未配置 LLM API Key（侧栏或环境变量 LLM_API_KEY / OPENAI_API_KEY 等）", spec: null };
  }
  const list = (Array.isArray(papers) ? papers : [])
    .slice(0, 50)
    .map((p, i) => {
      const s = paperSnippet(p);
      if (!s) return "";
      const yr = s.year != null ? `年份: ${s.year}` : "年份: （无）";
      return `[${i + 1}] ${s.idLine}\n${yr}\n标题: ${s.title}\n摘要摘录:\n${s.summary}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  if (!list) {
    return { ok: false, error: "没有可用的文献条目", spec: null };
  }

  const hint = String(opts.userHint ?? "").trim().slice(0, 500);

  const system =
    "你是「从文献摘录抽取数值并溯源」的助手。用户会给出若干条带标识符（DOI/arXiv/专利号/URL等）的摘要摘录（可能较长）。\n" +
    "文献类型包括学术论文、专利、网页等，所有类型均可提取数据。\n" +
    "任务：找出**摘要中明确写出**的数值，组成二维散点图的 (x, y)。\n" +
    "**重要原则：宁可多提取、不可遗漏**。只要摘要中有任何能用数字表示的物理量、性能指标、实验参数，都应该提取为一个数据点。\n" +
    "优先提取以下类型的数值：\n" +
    "- X轴优先：年份、温度、压力、浓度、剂量、尺寸、波长、频率、厚度\n" +
    "- Y轴优先：效率(%)、产率(%)、容量、密度、带隙(eV)、电导率、强度、硬度、模量、迁移率、透光率、热导率、功率密度、电流密度、电压、任何性能指标\n" +
    "**同一篇**内若同时出现年份与性能数，可用 doi_x=doi_y=该篇 DOI。\n" +
    "严格要求：\n" +
    "1) **不得编造**数字；x、y 必须能在对应摘录原文中找到；但只要能找到，就一定要提取，不要遗漏。\n" +
    "2) **每篇文献至少尝试提取 1-2 个点**：如果该篇摘要同时有多个性能指标（如效率+填充因子、电导率+热导率等），每个指标组合作为一个点。\n" +
    "3) 溯源方式任选其一：**(A)** 填 `doi_x`/`doi_y`（10.xxxx/… 或摘录头行的 DOI 原文）；**(B)** 仅有 arXiv 时 `arxiv_x`/`arxiv_y` 填如 2301.12345；**(C)** 填 `paper_index`（1 表示第 1 条摘录、2 表示第 2 条…），若 x、y 都来自同一篇则只填 `paper_index` 即可，服务端会映射到该条 DOI/arXiv。\n" +
    "4) 最多 60 个点；尽量让每篇文献都贡献至少一个点。同一年份的多个值请在±1.5范围内随机微调x坐标（如2022.0、2022.6、2022.3、2021.5…），避免点完全重叠。\n" +
    "5) **只输出一个 JSON 对象**，禁止 markdown 围栏、禁止注释。\n" +
    "JSON schema:\n" +
    '{ "title": string, "x_axis": { "label": string }, "y_axis": { "label": string }, "chart_type": "scatter",\n' +
    '  "points": [ { "x": number, "y": number, "doi": string|null, "doi_x": string|null, "doi_y": string|null,\n' +
    '               "arxiv_x": string|null, "arxiv_y": string|null, "paper_index": number|null,\n' +
    '               "paper_index_x": number|null, "paper_index_y": number|null, "quote": string } ]\n' +
    "}\n" +
    "示例（结构示意）：{\"title\":\"…\",\"x_axis\":{\"label\":\"年份\"},\"y_axis\":{\"label\":\"效率(%)\"},\"chart_type\":\"scatter\",\"points\":[{\"x\":2022,\"y\":24.5,\"paper_index\":1,\"quote\":\"we achieve 24.5%\"}]}";

  const defaultHint =
    "请为【每一条】摘要都至少产出一个数据点，不要遗漏任何一条文献。常见组合=\"年份→x、性能指标→y\"。没有性能指标的文献，可从摘要中找任意可度量的物理量作为y。务必填写paper_index。";
  const syn = String(opts.synthesisMarkdown ?? "").trim().slice(0, 8000);
  const synBlock =
    syn.length > 0
      ? `\n\n---- 以下为本次检索后的「综述」Markdown（可含 (DOI:…) 等引用；数值若能对应到上文的 [k] 条文献，请用该条的 paper_index 或 DOI 溯源）----\n\n${syn}\n`
      : "";
  const user =
    (hint ? `用户作图意图：${hint}\n\n` : `作图提示：${defaultHint}\n\n`) +
    "文献摘录如下（[1] 为第一条…，与 paper_index 对应）：\n\n" +
    list +
    synBlock;

  try {
    const result = await generateText(provider, {
      timeoutMs: 25_000,
      temperature: 0.22,
      maxTokens: 6000,
      system,
      messages: [{ role: "user", content: user }],
    });
    if (!result.ok) {
      return { ok: false, error: `LLM ${result.error}: ${result.errorBody.slice(0, 200)}`, spec: null };
    }
    let text = result.text;
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const spec = tryParseJsonLoose(text);
    if (!spec) return { ok: false, error: "模型输出不是合法 JSON", spec: null };
    return { ok: true, error: null, spec };
  } catch (e) {
    return { ok: false, error: e?.message || "抽取失败", spec: null };
  }
}

/** @param {string} text */
function tryParseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** @param {unknown} p 题录溯源：支持所有文献类型（DOI、arXiv、专利、网页、Scopus、Europe PMC等） */
function paperDoiOrArxivTag(p) {
  if (!p || typeof p !== "object") return "";
  const doi = String(p.doi ?? "").trim();
  if (doi) return doi;
  const aid = String(p.arxiv_id ?? "")
    .replace(/^arxiv:/i, "")
    .trim();
  const rawId = String(p.id ?? "")
    .replace(/^arxiv:/i, "")
    .trim();
  const ax = aid || rawId;
  if (ax && /^\d{4}\.\d{2,5}(v\d+)?$/i.test(ax)) return `arXiv:${ax}`;
  const pid = String(p.paper_id ?? "").trim();
  const absU = String(p.absUrl ?? "").trim();
  const src = String(p.source ?? "");
  if (src === "mcp_web" || src === "ddg_web") {
    return absU ? `url:${absU}` : `web_page:${pid || rawId || "unknown"}`;
  }
  if (src === "openalex_patent" || src === "ddg_patent") {
    return pid ? `patent:${pid}` : (absU ? `url:${absU}` : (rawId ? `id:${rawId.slice(0, 80)}` : "patent"));
  }
  if (src === "scopus") {
    return pid ? `scopus:${pid}` : (absU ? `scopus_url:${absU.slice(0, 120)}` : "scopus");
  }
  if (src === "europepmc") {
    return pid ? `europepmc:${pid}` : (absU ? `europepmc_url:${absU.slice(0, 120)}` : "europepmc");
  }
  if (src === "openalex") {
    return pid ? `openalex:${pid}` : (absU ? `openalex_url:${absU.slice(0, 120)}` : "openalex");
  }
  if (src === "semantic_scholar") {
    return pid ? `sem_scholar:${pid}` : (absU ? `sem_scholar_url:${absU.slice(0, 120)}` : "semantic_scholar");
  }
  if (pid) return `paper_id:${pid}`;
  if (absU) return `url:${absU}`;
  if (rawId) return `id:${rawId.slice(0, 80)}`;
  return "";
}

/**
 * @param {unknown} spec
 * @param {unknown[] | null} paperRefs 与请求体 papers 同序，用于 paper_index → DOI/arXiv
 */
export function normalizeChartSpec(spec, paperRefs = null) {
  if (!spec || typeof spec !== "object") return null;
  const title = String(spec.title ?? "文献数值图").trim() || "文献数值图";
  const x_axis = spec.x_axis && typeof spec.x_axis === "object" ? spec.x_axis : {};
  const y_axis = spec.y_axis && typeof spec.y_axis === "object" ? spec.y_axis : {};
  const xLabel = String(x_axis.label ?? "x").trim() || "x";
  const yLabel = String(y_axis.label ?? "y").trim() || "y";
  const raw = Array.isArray(spec.points) ? spec.points : [];
  const papers = Array.isArray(paperRefs) ? paperRefs : [];
  const points = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    let x;
    let y;
    try {
      x = Number(p.x);
      y = Number(p.y);
    } catch {
      continue;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const doi = p.doi != null ? String(p.doi).trim() : "";
    let doi_x = p.doi_x != null ? String(p.doi_x).trim() : "";
    let doi_y = p.doi_y != null ? String(p.doi_y).trim() : "";
    const arxiv_x = p.arxiv_x != null ? String(p.arxiv_x).replace(/^arxiv:/i, "").trim() : "";
    const arxiv_y = p.arxiv_y != null ? String(p.arxiv_y).replace(/^arxiv:/i, "").trim() : "";
    const quote = p.quote != null ? String(p.quote).trim().slice(0, 240) : "";
    const pin = Number(p.paper_index ?? p.paperIndex);
    const pinx = Number(p.paper_index_x ?? p.paperIndexX ?? p.n_x);
    const piny = Number(p.paper_index_y ?? p.paperIndexY ?? p.n_y);
    const tagFrom = (idx) => {
      if (!Number.isFinite(idx)) return "";
      const i = Math.floor(idx);
      if (i < 1 || i > papers.length) return "";
      return paperDoiOrArxivTag(papers[i - 1]);
    };
    const tagPin = tagFrom(pin);
    const tagX = tagFrom(pinx);
    const tagY = tagFrom(piny);
    if (!doi_x && !arxiv_x && tagPin) doi_x = tagPin;
    if (!doi_y && !arxiv_y && tagPin) doi_y = tagPin;
    if (!doi_x && !arxiv_x && tagX) doi_x = tagX;
    if (!doi_y && !arxiv_y && tagY) doi_y = tagY;
    const dx = doi_x || doi || (arxiv_x ? `arXiv:${arxiv_x}` : "");
    const dy = doi_y || doi || (arxiv_y ? `arXiv:${arxiv_y}` : "");
    if (!dx && !dy) continue;
    const paperIdx = Number.isFinite(pin) ? Math.floor(pin) - 1 : -1;
    let paper = paperIdx >= 0 && paperIdx < papers.length ? papers[paperIdx] : null;
    if (!paper && doi) {
      const dl = doi.toLowerCase();
      paper = papers.find(p => {
        const pd = String(p?.doi || "").trim().toLowerCase();
        return pd && pd === dl;
      }) || null;
    }
    if (!paper && dx && dx !== "—") {
      const dl = dx.toLowerCase();
      paper = papers.find(p => {
        const pd = String(p?.doi || "").trim().toLowerCase();
        return pd && pd === dl;
      }) || null;
    }
    const title = String((paper && paper.title) || "").slice(0, 100);
    points.push({
      x,
      y,
      doi: doi || null,
      doi_x: dx || "—",
      doi_y: dy || "—",
      title: title || null,
      quote: quote || null,
    });
    if (points.length >= 55) break;
  }
  if (!points.length) return null;
  return {
    schema_version: "paper_chart_v1",
    title,
    chart_type: "scatter",
    x_axis: { label: xLabel },
    y_axis: { label: yLabel },
    points,
  };
}

/**
 * LLM 无法出点时的后备：从每篇摘要抓年份（元数据或正文）与首个百分数或 eV，凑散点图。
 * @param {unknown[]} papers
 * @returns {object | null} 可交给 normalizeChartSpec 的原始 spec
 */
export function buildFallbackChartSpecFromAbstracts(papers) {
  const arr = Array.isArray(papers) ? papers.slice(0, 50) : [];
  const rawPoints = [];
  
  // 为每篇论文尝试提取数据点
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    const tag = paperDoiOrArxivTag(p);
    const summary = String(p.summary ?? p.abstract ?? "");
    const title = String(p.title ?? "").slice(0, 100);
    const paperId = tag || String(p.id ?? p.paper_id ?? "").slice(0, 80) || `文献-${i + 1}`;
    
    // 提取所有可能的数值
    const extractedValues = [];
    
    // 1. 百分数 (24.5%, 3.2 %, ...) - 太阳能效率等
    const pctMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*[％%]/g);
    for (const m of pctMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'percent' });
    }
    
    // 2. eV (1.5 eV, 0.95eV) - 带隙
    const evMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*eV\b/gi);
    for (const m of evMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'eV' });
    }
    
    // 3. 温度 (300 K 或 25°C)
    const tempMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:K|°C|°F)\b/g);
    for (const m of tempMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'temp' });
    }
    
    // 4. 波长/频率 (500 nm, 10 GHz)
    const waveMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:nm|μm|mm|cm|m|GHz|MHz|THz)\b/g);
    for (const m of waveMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'wave' });
    }
    
    // 5. 浓度/密度
    const concMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:g\/cm³|kg\/m³|mol\/L|M|mg\/mL|μg\/mL|wt%|vol%)/g);
    for (const m of concMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'conc' });
    }
    
    // 6. 电学单位
    const elecMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:mA\/cm²|mW\/cm²|W\/m²|W\/cm²|mA|mV|V|A|Ω|S\/cm|S\/m|μA|kW|MW|GW|TW|μW|nW|pW)/gi);
    for (const m of elecMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'elec' });
    }
    
    // 7. 厚度/尺寸 (nm, μm, mm)
    const thickMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:nm|μm|mm|cm|pm)\b/g);
    for (const m of thickMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'thick' });
    }

    // 8. 时间单位 (小时、分钟、秒、天) — 常见于专利和工艺描述
    const timeMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:小时|分钟|秒|天|h\b|min\b|s\b|day|hour|minute)/gi);
    for (const m of timeMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'time' });
    }

    // 9. 重量/质量 (g, kg, mg, μg, ton, lb)
    const massMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:g\b|kg\b|mg\b|μg\b|吨|千克|克|毫克)/gi);
    for (const m of massMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'mass' });
    }

    // 10. 长度/面积/体积 (m², m³, L, mL, ha, acre)
    const areaMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:m²|m³|L\b|mL\b|ha\b|acre|升|毫升|公顷)/gi);
    for (const m of areaMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'area' });
    }

    // 11. 速度/加速度 (m/s, km/h, rpm, Hz)
    const speedMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*(?:m\/s|km\/h|rpm|Hz\b|kHz\b|MHz\b)/gi);
    for (const m of speedMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'speed' });
    }

    // 12. 比率/倍数（如"3倍"、"2.5倍"、"提高了40%"）
    const ratioMatches = summary.matchAll(/(\d+(?:\.\d+)?)\s*倍/g);
    for (const m of ratioMatches) {
      extractedValues.push({ val: Number(m[1]), unit: m[0], type: 'ratio' });
    }
    const improvedMatches = summary.matchAll(/提高[了到达]?\s*(\d+(?:\.\d+)?)\s*[％%]/g);
    for (const m of improvedMatches) {
      extractedValues.push({ val: Number(m[1]), unit: '提高' + m[0], type: 'percent' });
    }
    
    // 13. 通用数字（最后尝试）
    if (extractedValues.length === 0) {
      const numMatches = summary.matchAll(/\b(\d+(?:\.\d+)?)\b/g);
      for (const m of numMatches) {
        const val = Number(m[1]);
        // 过滤掉年份和明显不合理的值
        if (val >= 0.001 && val < 10000 && !String(val).match(/^(19|20)\d{2}$/)) {
          extractedValues.push({ val, unit: m[0], type: 'generic' });
        }
      }
    }
    
    // X轴：年份或索引
    let x = p.year != null ? Number(p.year) : NaN;
    if (!Number.isFinite(x) || x < 1900 || x > 2100) {
      const ym = summary.match(/\b(19\d{2}|20\d{2})\b/);
      x = ym ? Number(ym[0]) : (i + 1);
    }
    
    // 为每个提取的数值创建一个点（先用较大偏移避免同一论文内重叠）
    if (extractedValues.length > 0) {
      const half = (extractedValues.length - 1) / 2;
      for (let j = 0; j < Math.min(extractedValues.length, 5); j++) {
        const ev = extractedValues[j];
        const spread = (j - half) * 0.4;
        rawPoints.push({
          x: x + spread,
          y: ev.val,
          doi: String(p.doi ?? "").trim() || null,
          doi_x: paperId,
          doi_y: paperId,
          title: title || null,
          quote: `${ev.unit} (${ev.type})`,
        });
        if (rawPoints.length >= 60) break;
      }
    } else {
      // 如果没有提取到数值，使用索引作为Y值（确保每篇论文至少有一个点）
      rawPoints.push({
        x,
        y: i + 1,
        doi: String(p.doi ?? "").trim() || null,
        doi_x: paperId,
        doi_y: paperId,
        title: title || null,
        quote: `文献 ${i + 1} (无明确数值)`,
      });
    }
    
    if (rawPoints.length >= 60) break;
  }
  
  // 第二轮：按x坐标分组，对同一x上重叠的点进行jitter散开
  const xGroups = new Map();
  for (const pt of rawPoints) {
    const xk = Math.round(pt.x * 10) / 10;
    if (!xGroups.has(xk)) xGroups.set(xk, []);
    xGroups.get(xk).push(pt);
  }
  const spreadPoints = [];
  for (const [, group] of xGroups) {
    if (group.length === 1) {
      spreadPoints.push(group[0]);
    } else {
      const half = (group.length - 1) / 2;
      const spreadWidth = Math.max(0.6, group.length * 0.25);
      for (let i = 0; i < group.length; i++) {
        spreadPoints.push({
          ...group[i],
          x: group[i].x + (i - half) * (spreadWidth / group.length),
        });
      }
    }
  }
  
  if (spreadPoints.length < 1) return null;
  
  return {
    title: `文献数值分布（共 ${spreadPoints.length} 个数据点）`,
    chart_type: "scatter",
    x_axis: { label: "年份/文献序号" },
    y_axis: { label: "提取的数值（效率%/带隙eV/温度/浓度等）" },
    points: spreadPoints,
  };
}

function isUsablePythonPath(p) {
  const s = String(p ?? "").trim();
  if (!s) return false;
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(s)) {
    console.warn("[chart] MATPLOTLIB_PYTHON 为 Windows 路径，当前系统已忽略:", s);
    return false;
  }
  return existsSync(s);
}

function pythonCmdCandidates() {
  const custom = String(process.env.MATPLOTLIB_PYTHON ?? "").trim();
  if (custom && isUsablePythonPath(custom)) return [[custom]];
  if (process.platform === "win32") {
    return [["python"], ["py", "-3"], ["python3"]];
  }
  return [["python3"], ["python"]];
}

/**
 * @param {object} spec normalized spec
 * @returns {Promise<{ ok: boolean; pngBase64?: string; stderr?: string; error?: string }>}
 */
export async function renderChartPngWithMatplotlib(spec) {
  const jsonPath = path.join(os.tmpdir(), `pq-chart-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const pngPath = path.join(os.tmpdir(), `pq-chart-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  let specJson;
  try {
    specJson = JSON.stringify(spec);
  } catch (e) {
    return {
      ok: false,
      error: `图表 JSON 无法序列化（可能含循环引用）: ${String(e?.message || e)}`,
    };
  }
  await fs.writeFile(jsonPath, specJson, "utf8");

  const trySpawn = (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let err = "";
      child.stderr?.on("data", (c) => {
        err += String(c);
      });
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: 124, err: err + "\n(timeout)" });
      }, 55_000);
      child.on("error", (spawnErr) => {
        clearTimeout(t);
        resolve({ code: 127, err: String(spawnErr?.message || spawnErr) });
      });
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ code: code ?? 1, err });
      });
    });

  let lastErr = "未执行";
  for (const parts of pythonCmdCandidates()) {
    const cmd = parts[0];
    const args = [...parts.slice(1), PY_SCRIPT, jsonPath, pngPath];
    const { code, err } = await trySpawn(cmd, args);
    if (code === 0) {
      try {
        const buf = await fs.readFile(pngPath);
        await fs.unlink(jsonPath).catch(() => {});
        await fs.unlink(pngPath).catch(() => {});
        return { ok: true, pngBase64: buf.toString("base64"), stderr: err.trim() || undefined };
      } catch (e) {
        lastErr = e?.message || "read png failed";
        break;
      }
    }
    lastErr = err.trim() || `exit ${code}`;
  }
  await fs.unlink(jsonPath).catch(() => {});
  await fs.unlink(pngPath).catch(() => {});
  return {
    ok: false,
    error:
      `Matplotlib 渲染失败：${lastErr.slice(0, 400)}。请安装 Python3 与 matplotlib，并确保命令在 PATH 中（或设置环境变量 MATPLOTLIB_PYTHON 指向 python 可执行文件）。示例：pip install matplotlib`,
  };
}
