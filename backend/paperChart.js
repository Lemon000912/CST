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
    "任务：从摘录中选择一组**含义一致、单位一致、可相互比较**的数值，组成二维散点图的 (x, y)。\n" +
    "**重要原则：可比性优先于数量**。一张图只能表达一个明确关系，例如“年份→比容量(mAh/g)”或“温度(°C)→效率(%)”。\n" +
    "禁止把效率、增长率、市场占比、温度、电压、容量、带隙等不同含义或不同单位的数字混在同一纵轴。\n" +
    "若无法找到至少 2 个含义和单位一致的可比点，返回空 points；不得用文献序号、任意数字或无明确物理含义的数字凑点。\n" +
    "严格要求：\n" +
    "1) **不得编造**数字；x、y 必须能在对应摘录原文中找到，并在 quote 中保留支持该点的短句。\n" +
    "2) 只收录与所选坐标含义完全一致的点，不要求每篇文献都贡献数据。\n" +
    "3) 溯源方式任选其一：**(A)** 填 `doi_x`/`doi_y`（10.xxxx/… 或摘录头行的 DOI 原文）；**(B)** 仅有 arXiv 时 `arxiv_x`/`arxiv_y` 填如 2301.12345；**(C)** 填 `paper_index`（1 表示第 1 条摘录、2 表示第 2 条…），若 x、y 都来自同一篇则只填 `paper_index` 即可，服务端会映射到该条 DOI/arXiv。\n" +
    "4) 最多 60 个点；不要为了避免重叠而篡改原始数值，渲染器会自动处理重叠。\n" +
    "5) **只输出一个 JSON 对象**，禁止 markdown 围栏、禁止注释。\n" +
    "JSON schema:\n" +
    '{ "title": string, "x_axis": { "label": string }, "y_axis": { "label": string }, "chart_type": "scatter",\n' +
    '  "points": [ { "x": number, "y": number, "doi": string|null, "doi_x": string|null, "doi_y": string|null,\n' +
    '               "arxiv_x": string|null, "arxiv_y": string|null, "paper_index": number|null,\n' +
    '               "paper_index_x": number|null, "paper_index_y": number|null, "quote": string } ]\n' +
    "}\n" +
    "示例（结构示意）：{\"title\":\"…\",\"x_axis\":{\"label\":\"年份\"},\"y_axis\":{\"label\":\"效率(%)\"},\"chart_type\":\"scatter\",\"points\":[{\"x\":2022,\"y\":24.5,\"paper_index\":1,\"quote\":\"we achieve 24.5%\"}]}";

  const defaultHint =
    "请从全部摘录中选择数据最充分的一组同含义、同单位指标作图。常见组合为“年份→同一种性能指标”。宁可只保留少量可靠点，也不要混合不同指标；务必填写 paper_index 和 quote。";
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
    const timeoutMs = Math.min(
      180_000,
      Math.max(25_000, Number(process.env.PAPER_CHART_TIMEOUT_MS) || 120_000),
    );
    const result = await generateText(provider, {
      timeoutMs,
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
 * LLM 无法形成图表时的保守后备：只选择一种单位明确的指标，绝不混合不同物理量。
 * 后备点用于展示与重试提示，不作为有效计费点。
 * @param {unknown[]} papers
 * @returns {object | null} 可交给 normalizeChartSpec 的原始 spec
 */
export function buildFallbackChartSpecFromAbstracts(papers) {
  const arr = Array.isArray(papers) ? papers.slice(0, 50) : [];
  const metrics = [
    {
      type: "specific_capacity",
      label: "比容量 (mAh/g)",
      regex: /(\d+(?:\.\d+)?)\s*(mAh\s*\/\s*g|Ah\s*\/\s*kg)\b/gi,
      convert: (value) => value,
    },
    {
      type: "voltage",
      label: "电压 (V)",
      regex: /(\d+(?:\.\d+)?)\s*(mV|V)\b/gi,
      convert: (value, unit) => (/^mv$/i.test(unit) ? value / 1000 : value),
    },
    {
      type: "energy_ev",
      label: "能量/带隙 (eV)",
      regex: /(\d+(?:\.\d+)?)\s*(eV)\b/gi,
      convert: (value) => value,
    },
    {
      type: "percent",
      label: "百分数 (%)",
      regex: /(\d+(?:\.\d+)?)\s*([％%])/g,
      convert: (value) => value,
    },
  ];
  const candidatesByType = new Map(metrics.map((metric) => [metric.type, []]));

  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    const summary = String(p?.summary ?? p?.abstract ?? "");
    if (!summary) continue;
    const sourceTag = paperDoiOrArxivTag(p);
    if (!sourceTag) continue;
    let x = p?.year != null ? Number(p.year) : NaN;
    if (!Number.isFinite(x) || x < 1900 || x > 2100) {
      const yearMatch = summary.match(/\b(19\d{2}|20\d{2})\b/);
      x = yearMatch ? Number(yearMatch[0]) : i + 1;
    }
    for (const metric of metrics) {
      let addedForPaper = 0;
      for (const match of summary.matchAll(metric.regex)) {
        const rawValue = Number(match[1]);
        const value = metric.convert(rawValue, String(match[2] ?? ""));
        if (!Number.isFinite(value)) continue;
        candidatesByType.get(metric.type).push({
          x,
          y: value,
          doi: String(p?.doi ?? "").trim() || null,
          doi_x: sourceTag,
          doi_y: sourceTag,
          paper_index: i + 1,
          quote: match[0],
        });
        addedForPaper += 1;
        if (addedForPaper >= 2) break;
      }
    }
  }

  const selectedMetric = metrics
    .map((metric) => ({ metric, points: candidatesByType.get(metric.type) }))
    .filter((entry) => entry.points.length >= 2)
    .sort((a, b) => {
      const paperCountA = new Set(a.points.map((point) => point.paper_index)).size;
      const paperCountB = new Set(b.points.map((point) => point.paper_index)).size;
      return paperCountB - paperCountA || b.points.length - a.points.length;
    })[0];
  if (!selectedMetric) return null;

  const points = selectedMetric.points.slice(0, 55);
  return {
    title: `${selectedMetric.metric.label}文献分布（规则后备）`,
    chart_type: "scatter",
    x_axis: { label: "年份/文献序号" },
    y_axis: { label: selectedMetric.metric.label },
    points,
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
