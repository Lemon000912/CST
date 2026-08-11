/**
 * 深度文献管线：下载 PDF → MinerU(pipeline) → 三个模型各抽一轮结构化关键词 →（由 index 再调）综合回答。
 * 版权声明与合规由使用者自负；仅用于已获授权的文献。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultModel } from "./rewrite.js";
import {
  resolvePrimaryProvider,
  resolveTriProviders,
  withProviderModel,
} from "./llmProviders.js";
import { generateText } from "./llmClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

/** @returns {string} */
export function resolveMineruExecutable() {
  const env = String(process.env.MINERU_EXE ?? "").trim();
  if (env && fs.existsSync(env)) return env;
  const win = process.platform === "win32";
  const rel = win
    ? path.join(PROJECT_ROOT, ".venv-mineru", "Scripts", "mineru.exe")
    : path.join(PROJECT_ROOT, ".venv-mineru", "bin", "mineru");
  if (fs.existsSync(rel)) return rel;
  return "mineru";
}

function deepModels() {
  const d = defaultModel();
  return [
    String(process.env.DEEP_MINE_MODEL_1 ?? "").trim() || d,
    String(process.env.DEEP_MINE_MODEL_2 ?? "").trim() || d,
    String(process.env.DEEP_MINE_MODEL_3 ?? "").trim() || d,
  ];
}

/** @param {string} url @param {number} maxBytes */
async function downloadPdf(url, maxBytes) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("非 http(s) 链接");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "PaperQuery-DeepMine/1.0 (academic)",
        Accept: "application/pdf,*/*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
    if (buf.length < 400) throw new Error("文件过小");
    const head = buf.slice(0, 5).toString("ascii");
    if (!head.startsWith("%PDF")) throw new Error("非 PDF 内容");
    return buf;
  } finally {
    clearTimeout(t);
  }
}

/** @param {string} dir @param {string[]} out */
function walkMdFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMdFiles(p, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) out.push(p);
  }
  return out;
}

/** @param {string} outDir @param {number} maxLen */
function readMarkdownDigest(outDir, maxLen = 28_000) {
  const mds = walkMdFiles(outDir);
  if (!mds.length) return "";
  mds.sort((a, b) => (fs.statSync(b).size || 0) - (fs.statSync(a).size || 0));
  let s = "";
  for (const f of mds) {
    const chunk = fs.readFileSync(f, "utf8");
    s += `\n\n<!-- ${path.basename(f)} -->\n\n${chunk}`;
    if (s.length >= maxLen) return s.slice(0, maxLen);
  }
  return s;
}

/**
 * @param {string} mineruExe
 * @param {string} pdfPath
 * @param {string} workOutDir
 * @param {number} timeoutMs
 */
export function runMineruPdf(mineruExe, pdfPath, workOutDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(workOutDir, { recursive: true });
    const args = ["-p", pdfPath, "-o", workOutDir, "-b", "pipeline", "-l", "ch"];
    const proc = spawn(mineruExe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    proc.stderr.on("data", (c) => {
      log += c.toString();
    });
    proc.stdout.on("data", (c) => {
      log += c.toString();
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error("MinerU 超时"));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`MinerU 退出 ${code}: ${log.slice(0, 500)}`));
    });
  });
}

/**
 * @param {{ userQuery: string; paperTitle: string; markdownDigest: string; apiKey?: string; model: string; chatUrl?: string }} p
 */
export async function keywordsFromLlm(p) {
  const provider = p.provider || resolvePrimaryProvider({
    apiKey: p.apiKey,
    model: p.model,
    chatCompletionsUrl: p.chatUrl,
  });
  const m = provider?.model || String(p.model || "").trim() || defaultModel();
  if (!provider) return { ok: false, error: "no-llm-key", model: m };
  const system =
    "你是文献信息抽取助手。只输出一个合法 JSON 对象，不要用 markdown 围栏。字段：keywords_zh(string[]), keywords_en(string[]), entities(string[]), methods(string[]), metrics(string[]), constraints(string[]), extractedData(对象数组，每项含 metric,value,unit?,condition?,context?；摘录中**每一个**明确数值/百分比/范围/性能指标都须列出，宁可多不可漏), steps(涉及工艺时填 step_no,action,inputs?,outputs?，否则[])。不确定则空数组。";
  const user = `用户问题：\n${String(p.userQuery).slice(0, 2000)}\n论文标题：\n${String(p.paperTitle).slice(0, 400)}\n\nPDF→Markdown 摘录：\n${String(p.markdownDigest).slice(0, 14000)}`;
  const result = await generateText(provider, {
    timeoutMs: 120_000,
    temperature: 0.12,
    maxTokens: 1400,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (!result.ok) {
    return { ok: false, error: result.error, detail: result.errorBody.slice(0, 200), model: m };
  }
  const text = result.text;
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const data = JSON.parse(cleaned);
    return { ok: true, data, model: m };
  } catch {
    return { ok: false, error: "json_parse", model: m, rawPreview: text.slice(0, 320) };
  }
}

/**
 * @param {{ userQuery: string; runs: object[]; personaSkill?: string; apiKey?: string; model?: string; chatUrl?: string }} p
 * @returns {Promise<{ markdown: string | null; note: string }>}
 */
export async function synthesizeDeepFromMine(p) {
  const provider = resolvePrimaryProvider({
    apiKey: p.apiKey,
    model: p.model,
    chatCompletionsUrl: p.chatUrl,
  });
  if (!provider) return { markdown: null, note: "deep_synth:no-key" };
  const m = provider.model;
  const skill = String(p.personaSkill ?? "").trim().slice(0, 2400);
  const payload = JSON.stringify(p.runs ?? []).slice(0, 28_000);
  const system = `你是科研助手。根据「用户问题」与下列 JSON（每篇文献经 MinerU 摘录 + 三模型关键词抽取）写中文**深度综合**，分块且勿混写：\n\n## 直接结论\n1) 先直接回答问题；\n2) 用项目符号列 3～8 条要点（须与用户问题直接相关，材料/方法/数据能在 JSON 中找到依据）；\n3) 摘录未覆盖处写「摘录未显示」。\n\n## 关键数据与指标\n若 JSON 的 metrics 或 extractedData 中有数值，用 Markdown 表格列出：指标 | 数值 | 单位 | 条件 | 文献标题简写；禁止编造。\n\n## 间接参考与延伸线索\n仅写与问题非直接对应、可作类比/背景的条目，每条以 **【间接】** 开头；若无则写「无单独间接参考条目」。\n\n勿编造 DOI。\n\n身份/用途：\n${skill || "（无）"}`;
  const user = `用户问题：\n${String(p.userQuery).slice(0, 4000)}\n\n文献结构化抽取（JSON）：\n${payload}`;
  const result = await generateText(provider, {
    timeoutMs: 180_000,
    temperature: 0.28,
    maxTokens: 2800,
    system,
    messages: [{ role: "user", content: user }],
  });
  if (!result.ok) {
    return { markdown: null, note: `deep_synth:${result.error}:${result.errorBody.slice(0, 200)}` };
  }
  const md = result.text;
  return { markdown: md || null, note: md ? "deep_synth:ok" : "deep_synth:empty" };
}

/**
 * @param {{
 *   papers: object[];
 *   userQuery: string;
 *   apiKey?: string;
 *   chatCompletionsUrl?: string;
 *   maxPapers?: number; // 正整数：最多处理篇数；省略则处理全部（可用环境变量 DEEP_MINE_MAX_PAPERS 限制）
 *   maxPdfMb?: number;
 * }} opts
 */
export async function runDeepMinePipeline(opts) {
  const papers = Array.isArray(opts.papers) ? opts.papers : [];
  const userQuery = String(opts.userQuery ?? "").trim();
  const nAll = papers.length;
  const fromOpts = Number(opts.maxPapers);
  const fromEnv = Number(process.env.DEEP_MINE_MAX_PAPERS);
  /** 未指定时处理全部返回文献；可用请求体 maxPapers 或环境变量 DEEP_MINE_MAX_PAPERS 限制篇数 */
  let maxPapers = nAll;
  if (Number.isFinite(fromOpts) && fromOpts > 0) maxPapers = Math.min(nAll, Math.floor(fromOpts));
  else if (Number.isFinite(fromEnv) && fromEnv > 0) maxPapers = Math.min(nAll, Math.floor(fromEnv));
  maxPapers = Math.max(0, maxPapers);
  const mb = Math.min(40, Math.max(1, Number(opts.maxPdfMb) || Number(process.env.DEEP_MINE_MAX_PDF_MB) || 20));
  const maxBytes = mb * 1024 * 1024;
  const mineruExe = resolveMineruExecutable();
  const mineruTimeout = Math.min(
    900_000,
    Number(process.env.DEEP_MINE_MINERU_TIMEOUT_MS ?? 600_000) || 600_000,
  );
  const primary = resolvePrimaryProvider({
    apiKey: opts.apiKey,
    chatCompletionsUrl: opts.chatCompletionsUrl,
  });
  const triProviders = resolveTriProviders({ chatCompletionsUrl: opts.chatCompletionsUrl });
  const models = triProviders
    ? [triProviders.A.model, triProviders.B.model, triProviders.C.model]
    : deepModels();
  const keywordProviders = triProviders
    ? [triProviders.A, triProviders.B, triProviders.C]
    : models.map((model, index) => withProviderModel(primary, model, String(index + 1)));

  const tmpBase = path.join(PROJECT_ROOT, "server", "data", "deep-mine-temp");
  await fs.promises.mkdir(tmpBase, { recursive: true });
  const sessionDir = path.join(tmpBase, `s-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  await fs.promises.mkdir(sessionDir, { recursive: true });

  /** @type {{ note: string; mineruExe: string; models: string[]; papers: object[] }} */
  const out = {
    enabled: true,
    note: "deep_mine:started",
    mineruExe,
    models,
    papers: [],
  };

  const slice = papers.slice(0, maxPapers);

  try {
    for (let i = 0; i < slice.length; i++) {
      const p = slice[i];
      const title = String(p.title ?? "").slice(0, 500);
      const pdfUrl = String(p.pdfUrl ?? "").trim();
      const doi = String(p.doi ?? "").trim();
      /** @type {{ title: string; doi: string | null; pdfUrl: string; steps: string[]; keywordModels: object[]; mdPreview: string; errors: string[] }} */
      const row = {
        title,
        doi: doi || null,
        pdfUrl,
        steps: [],
        keywordModels: [],
        mdPreview: "",
        errors: [],
      };

      if (!/^https?:\/\//i.test(pdfUrl)) {
        row.errors.push("invalid_pdf_url");
        out.papers.push(row);
        continue;
      }

      const paperDir = path.join(sessionDir, `p${i}`);
      await fs.promises.mkdir(paperDir, { recursive: true });
      const pdfPath = path.join(paperDir, "input.pdf");
      const mineruOut = path.join(paperDir, "mineru_out");

      try {
        const buf = await downloadPdf(pdfUrl, maxBytes);
        await fs.promises.writeFile(pdfPath, buf);
        row.steps.push("download:ok");
      } catch (e) {
        row.errors.push(`download:${e?.message || e}`);
        out.papers.push(row);
        continue;
      }

      try {
        await runMineruPdf(mineruExe, pdfPath, mineruOut, mineruTimeout);
        row.steps.push("mineru:ok");
      } catch (e) {
        row.errors.push(`mineru:${e?.message || e}`);
        out.papers.push(row);
        continue;
      }

      const digest = readMarkdownDigest(mineruOut, 30_000);
      row.mdPreview = digest.slice(0, 3000);

      const km = await Promise.all(
        keywordProviders.map(async (provider, providerIndex) => {
          const model = provider?.model || models[providerIndex] || defaultModel();
          try {
            const r = await keywordsFromLlm({
              userQuery,
              paperTitle: title,
              markdownDigest: digest,
              provider,
              model,
            });
            return sanitizeKwRow(r);
          } catch (e) {
            return { ok: false, error: e?.message || String(e), model };
          }
        }),
      );
      row.keywordModels = km;
      out.papers.push(row);
    }

    const anyKw = out.papers.some((x) => (x.keywordModels || []).some((k) => k.ok));
    out.note = anyKw ? "deep_mine:ok" : out.papers.length ? "deep_mine:no_keywords" : "deep_mine:no_papers";
    return out;
  } finally {
    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** @param {object} r */
function sanitizeKwRow(r) {
  if (!r || typeof r !== "object") return r;
  const o = { ...r };
  if (o.rawPreview) o.rawPreview = String(o.rawPreview).slice(0, 200);
  if (o.detail) o.detail = String(o.detail).slice(0, 200);
  return o;
}
