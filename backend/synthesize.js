import { sanitizeModel, defaultModel } from "./rewrite.js";
import {
  resolvePrimaryProvider,
  resolveTriProviders,
  withProviderModel,
} from "./llmProviders.js";
import { generateText } from "./llmClient.js";
import { extractPatentNumberFromPaper } from "./patentNumber.js";
import {
  SYNTH_JSON_FOOTER,
  SYNTH_MARKDOWN_DATA_SECTION,
  finalizeSynthesisMarkdown,
} from "./synthesisExtract.js";
import { traceAsync } from "./performanceTrace.js";

function isPatentPaper(p) {
  const s = String(p?.source ?? "");
  return s === "ddg_patent" || s === "openalex_patent";
}

function isWebOnlyPaper(p) {
  const s = String(p?.source ?? "");
  return (
    s === "mcp_web" ||
    s === "ddg_web" ||
    s === "dataify_web" ||
    s === "tavily_web" ||
    s === "searx_web" ||
    s === "qwant_web" ||
    s === "mojeek_web"
  );
}

/**
 * 综述输入：专利、网页优先占位，避免合并排序后专利落在数组末尾而被前 14 条「全网」截断。
 * @param {object[]} papers
 * @param {number} max
 */
function pickPapersForSynthesis(papers, max) {
  const arr = Array.isArray(papers) ? [...papers] : [];
  const cap = Math.min(60, Math.max(1, Number(max) || 35));
  const patents = arr.filter(isPatentPaper);
  const webs = arr.filter(isWebOnlyPaper);
  const scholarly = arr.filter((p) => !isPatentPaper(p) && !isWebOnlyPaper(p));
  const maxP = Math.min(12, patents.length, cap);
  const maxW = Math.min(12, webs.length, Math.max(0, cap - maxP));
  const maxS = Math.max(0, cap - maxP - maxW);
  return [...patents.slice(0, maxP), ...webs.slice(0, maxW), ...scholarly.slice(0, maxS)];
}

/** @param {object} p @param {number} idx 1-based */
function paperBlock(p, idx) {
  const doi = String(p.doi ?? "").trim();
  const ax = String(p.id ?? p.arxiv_id ?? "")
    .replace(/^arxiv:/i, "")
    .trim();
  const title = String(p.title ?? "").slice(0, 200);
  const authors = Array.isArray(p.authors) ? p.authors.join(", ") : String(p.authors ?? "");
  const src = String(p.source ?? "");
  const absU = String(p.absUrl ?? "").trim();
  const abstRaw = String(p.summary ?? p.abstract ?? "");
  const abst = abstRaw.slice(
    0,
    ["mcp_web", "ddg_web", "ddg_patent", "dataify_web", "tavily_web", "openalex_patent"].includes(src)
      ? 360
      : 240,
  );
  let idLine = "";
  if (doi) idLine = `DOI: ${doi}`;
  else if (ax) idLine = `arXiv: ${ax}`;
  else if (src === "ddg_patent" || src === "openalex_patent") {
    const pn = String(p.patentNumber ?? "").trim() || extractPatentNumberFromPaper(p);
    idLine = pn
      ? `专利公开号: ${pn}${absU ? ` | 链接: ${absU.slice(0, 220)}` : ""}`
      : absU
        ? `专利/网页条目 | URL: ${absU.slice(0, 220)}`
        : "专利条目（无链接）";
  } else if (
    src === "mcp_web" ||
    src === "ddg_web" ||
    src === "dataify_web" ||
    src === "tavily_web" ||
    src === "searx_web" ||
    src === "qwant_web" ||
    src === "mojeek_web"
  ) {
    idLine = absU ? `网页 | URL: ${absU.slice(0, 240)}` : "网页条目（无 URL）";
  } else if (src === "openalex") {
    const oid = String(p.paper_id ?? "")
      .replace(/^openalex:/i, "")
      .trim();
    idLine = oid ? `OpenAlex: ${oid}` : absU ? `OpenAlex: ${absU.slice(0, 120)}` : "OpenAlex";
  } else if (src === "scopus" && absU) idLine = `Scopus: ${absU.slice(0, 200)}`;
  else if (src === "europepmc") {
    idLine = doi ? `DOI: ${doi}` : absU ? `Europe PMC: ${absU.slice(0, 160)}` : "Europe PMC";
  } else idLine = "（无 DOI / 无 arXiv id）";
  const typeTag =
    src === "ddg_patent" || src === "openalex_patent"
      ? "专利"
      : src === "mcp_web" ||
          src === "ddg_web" ||
          src === "dataify_web" ||
          src === "tavily_web" ||
          src === "searx_web" ||
          src === "qwant_web" ||
          src === "mojeek_web"
        ? "网页"
        : "文献";
  return `[${idx}] 类型:${typeTag} | ${idLine}\n标题: ${title}\n作者: ${authors.slice(0, 220)}\n摘要摘录: ${abst}`;
}

const SYNTH_SYSTEM =
  "你是科研文献综述专家。请基于提供的文献摘录，生成一份结构化的文献综述。\n\n" +
  "输出要求（使用二级标题 ##）：\n\n" +
  "## 研究背景与意义\n" +
  "简述该领域的研究背景和重要性（100-150字），必须引用至少1篇相关文献：(DOI:…) 或 [n]\n\n" +
  "## 主要研究进展\n" +
  "按主题分类总结文献中的主要发现（300-500字）。每类主题必须使用 (DOI:…) 或 [n] 标注文献来源，至少引用5篇不同文献。\n\n" +
  "## 关键技术与方法\n" +
  "总结常用的研究方法、技术路线和实验手段（150-250字），必须引用至少2篇相关文献标注来源。\n\n" +
  "## 研究趋势与展望\n" +
  "基于提供的文献，分析该领域的发展趋势、存在问题及未来方向（200-300字）。此章节为综述重点，必须充分引用文献中的具体发现来支撑每个观点，使用 (DOI:…) 或 [n] 标注至少5篇不同文献来源。明确指出哪些方向已有充分研究、哪些方向存在空白或不足。\n\n" +
  "## 间接参考与延伸线索\n" +
  "**本小节与上文四节严格分离，不得混写。** 仅收录：与用户问题**非直接对应**、但可作类比/背景/方法借鉴的摘录（如其它材料体系、邻近工艺、细胞/力学隐喻等）。每条须以 **「【间接】」** 开头，写明为何仅作延伸参考（1 句），再写可借鉴点并标注 (DOI:…) 或 [n]。若无此类文献，写一句「无单独间接参考条目」即可，**禁止**把间接内容塞进上文四节。\n\n" +
  "注意事项：\n" +
  "- 事实必须来自提供的文献摘录，不得编造\n" +
  "- **直接回答**（背景、进展、技术、趋势四节）：只写与用户问题**直接相关**的摘录；不得为凑引用写入跑题篇目\n" +
  "- **间接参考**（仅「## 间接参考与延伸线索」）：跑题、弱相关、仅背景类比的条目**只能**出现在此节，且须标 **【间接】**\n" +
  "- 引用格式：论文用 (DOI:10.xxxx) 或 [n]；**网页**须写出摘录中的 **完整 URL**（可附 [n]）；**专利**须写出摘录中的 **专利公开号/申请号**（如 CN…、US…、WO…、EP…），并与 [n] 对应\n" +
  "- 摘录中带「类型:网页」「类型:专利」的条目：与问题**直接相关**的写入上文合适小节；仅间接相关的写入「## 间接参考与延伸线索」\n" +
  "- **禁止**以「特别说明」「所选文献未涉及」「来源未覆盖」等**长段免责**代替实质内容；若无网页/专利摘录，仅用一两句说明即可\n" +
  "- 使用简体中文，语言简洁专业\n" +
  "- 总字数控制在1800字左右（含间接参考小节）\n" +
  "- 上文四节都必须包含**直接相关**的文献引用；间接条目**不得**出现在四节正文中" +
  SYNTH_MARKDOWN_DATA_SECTION +
  SYNTH_JSON_FOOTER;

/** 摘录中含专利时追加到 system，强制模型输出专利小节 */
function synthPatentMandatorySuffix(patentCount) {
  const n = Math.max(0, Math.floor(Number(patentCount) || 0));
  if (!n) return "";
  return (
    `\n\n【专利输出（强制）】\n` +
    `- 上文「以下为检索到的摘录」中，含「类型:专利」共 **${n}** 条。正文**必须**包含独立小节 **## 专利与公开情报**（不可省略、不可仅用括号一句带过）。\n` +
    `- 该小节须**逐条**对应摘录中的专利：每条至少一句技术要点，并写出摘录中的**专利公开号/申请号**（若有）及**链接 URL**（若有，须与摘录一致）。\n` +
    `- **禁止**使用「摘录未涉及具体专利」「未涉及专利公开号」「无专利信息」「来源未覆盖专利」等否定或免责表述。\n` +
    `- 其它章节可与专利交叉引用，但「## 专利与公开情报」须有实质内容，不得为空。\n`
  );
}

/** 合并/仲裁阶段：避免「仅一篇提到专利」被共识步骤删光 */
/** 仲裁失败时优先取含 extractedData 较多的一侧 plan */
function pickBranchPlan(ra, rb) {
  const score = (p) =>
    Array.isArray(p?.extractedData) ? p.extractedData.length : 0;
  const a = ra?.plan;
  const b = rb?.plan;
  if (score(a) >= score(b) && a) return a;
  if (b) return b;
  return a || b || null;
}

function mergePatentPreserveSuffix(patentCount) {
  const n = Math.max(0, Math.floor(Number(patentCount) || 0));
  if (!n) return "";
  return (
    `\n\n【摘录含专利 ${n} 条】（**以下条款优先于**合并提示词中「仅单独一篇综述写出则删除」的一般规则）\n` +
    `- 终稿须保留专利公开号或 URL 及至少一条与摘录一致的技术要点。\n` +
    `- 若仅模型 A 或仅模型 B 写了专利内容：只要与检索摘录一致，**必须保留**，不得以「另一篇未写」为由删除。\n` +
    `- 禁止终稿声称「无专利」「摘录未涉及专利」等，除非两份综述均未出现任何可核对摘录的专利信息（此时仍不得编造）。\n`
  );
}

/**
 * 解析第二模型：请求头 x-model-b、JSON modelB，或环境变量 LLM_MODEL_B。
 * 若与主模型同名则视为未配置（避免重复调用）。
 */
export function resolveSecondaryModel(primaryModel, modelBFromClient) {
  const raw =
    String(modelBFromClient ?? "").trim() ||
    String(process.env.LLM_MODEL_B ?? "").trim();
  if (!raw) return "";
  const sec = sanitizeModel(raw);
  const pri = sanitizeModel(primaryModel);
  if (sec === pri) return "";
  return sec;
}

function avoidanceSystemSuffix(hint) {
  const h = String(hint ?? "").trim();
  if (!h) return "";
  return `\n\n【输出偏好（须遵守）】\n${h.slice(0, 2000)}`;
}

/** 单模型回退：主 Key 失败后依次用三密钥各槽再试（缓解主 LLM_API_KEY 与网关不匹配时的 401） */
async function synthesisFallbackWithTriKeys(base, primary, triCfg) {
  let fb = await runSingleSynthesisModel({ ...base, provider: primary });
  if (fb.markdown) return fb;
  if (!triCfg) return fb;
  for (const provider of [triCfg.A, triCfg.B, triCfg.C]) {
    if (!provider || provider.apiKey === primary?.apiKey) continue;
    const r2 = await runSingleSynthesisModel({ ...base, provider });
    if (r2.markdown) {
      return { markdown: r2.markdown, note: `${fb.note}·synth:fallback_tri_key_ok` };
    }
  }
  return fb;
}

/**
 * @param {{ userQuery: string; papers: object[]; apiKey: string; model: string; chatCompletionsUrl: string; personaSkill?: string; outputAvoidanceHint?: string }} args
 * @returns {Promise<{ markdown: string | null; note: string }>}
 */
async function runSingleSynthesisModel(args) {
  const papers = pickPapersForSynthesis(Array.isArray(args.papers) ? args.papers : [], 35);
  const list = papers.map((x, i) => paperBlock(x, i + 1)).join("\n\n---\n\n");
  const nPat = papers.filter(isPatentPaper).length;
  const userQuery = String(args.userQuery ?? "").trim().slice(0, 8000);
  const convo = String(args.conversationContext ?? "").trim().slice(0, 2500);
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2800);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = avoidanceSystemSuffix(args.outputAvoidanceHint);
  const patentSys = synthPatentMandatorySuffix(nPat);

  const ms = Math.min(360_000, Math.max(25_000, Number(process.env.SYNTHESIS_TIMEOUT_MS) || 120_000));

  try {
    const result = await traceAsync(
      args.performanceTrace,
      `synthesis.literature.${String(args.provider?.slot || "single").replace(/[^a-z0-9_-]/gi, "_")}`,
      { model: args.provider?.model, streaming: typeof args.onTextDelta === "function" },
      () => generateText(args.provider, {
        timeoutMs: ms,
        temperature: 0.3,
        maxTokens: 6000,
        system: skillPrefix + SYNTH_SYSTEM + patentSys + avoid,
        messages: [
        {
          role: "user",
          content:
            (convo ? `【本对话上文】\n${convo}\n\n` : "") +
            `用户检索问题：${userQuery}\n\n` +
            (nPat > 0 ? `【摘录统计】含「类型:专利」${nPat} 条（须按系统「专利输出（强制）」执行）。\n\n` : "") +
            `以下为检索到的摘录（含「文献 / 网页 / 专利」类型标签；共${papers.length}条）：\n\n${list}\n\n` +
            "请基于以上摘录生成综述；**直接相关**内容写入背景/进展/技术/趋势四节；**仅间接相关**的条目只能写入 **## 间接参考与延伸线索** 且每条以 **【间接】** 开头。专利若与问题直接相关可写 **## 专利与公开情报**（放在间接参考节之前），否则放入间接参考节。",
        },
        ],
        ...(typeof args.onTextDelta === "function" ? { onTextDelta: args.onTextDelta } : {}),
      }),
      (value) => ({ status: value?.status, outputChars: String(value?.text ?? "").length, error: value?.error }),
    );
    if (!result.ok) {
      console.error("[synthesize] LLM", args.provider?.slot, args.provider?.model, result.status, result.error);
      return { markdown: null, note: `synth:${result.error}` };
    }
    const text = result.text;
    if (!text) return { markdown: null, note: "synth:empty" };
    const fin = finalizeSynthesisMarkdown(text);
    return { markdown: fin.markdown, note: "synth:ok", plan: fin.plan, planNote: fin.planNote };
  } catch (e) {
    console.error("[synthesize] error", args.provider?.model, e);
    return { markdown: null, note: `synth_err:${e?.message || "unknown"}` };
  }
}

/**
 * @param {{ userQuery: string; markdownA: string; markdownB: string; apiKey: string; model: string; chatCompletionsUrl: string; personaSkill?: string; outputAvoidanceHint?: string; arbitratorMode?: boolean; excerptPatentCount?: number }} args
 */
async function mergeConsensusMarkdown(args) {
  const userQuery = String(args.userQuery ?? "").trim().slice(0, 8000);
  const a = String(args.markdownA ?? "").trim().slice(0, 12_000);
  const b = String(args.markdownB ?? "").trim().slice(0, 12_000);
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = avoidanceSystemSuffix(args.outputAvoidanceHint);
  const arbitrator = Boolean(args.arbitratorMode);
  const excerptPatentCount = Math.max(0, Math.floor(Number(args.excerptPatentCount) || 0));
  const patentMerge = mergePatentPreserveSuffix(excerptPatentCount);
  const systemArb =
    skillPrefix +
    "你是第三模型（仲裁）。已给定同一用户问题下、基于同一批文献的两份综述（模型 A 与模型 B）。请比较后输出**唯一终稿**（简体中文）。\n\n" +
    "规则：\n" +
    "- 优先保留两份中一致、可相互印证、且可由文献摘录共同支撑的论述；删除无依据的发挥。\n" +
    "- 若某一论断仅出现在其中一份：若无文献摘录支持则删去；若有摘录支持可谨慎保留并注明依据。\n" +
    "- 若两份在事实或结论上矛盾：采信更保守、与摘录更一致的一方；可用一两句话说明已仲裁分歧（勿展开争论）。\n" +
    "- 保留 (DOI:…) / [n] / arXiv 等引用格式；不得编造文献中不存在的信息。\n" +
    "- 可用二级标题 ##；须保留 **## 关键数据与指标**（若任一侧含数值表则合并保留，禁止删光数据行）；须保留独立小节 **## 间接参考与延伸线索**（间接条目仅在此节，每条以 **【间接】** 开头）；篇幅可接近较长的一篇综述。" +
    SYNTH_JSON_FOOTER +
    (avoid
      ? "\n- 终稿还须遵守下文【输出偏好】：弱化用户不喜欢的表述方式，但不牺牲可验证事实。"
      : "") +
    patentMerge +
    avoid;
  const systemMerge =
    skillPrefix +
    "你是严谨的科学编辑。给定同一用户问题下、基于同一批文献的两份综述（模型 A 与模型 B），请只输出「共享部分」。\n\n" +
    "规则：\n" +
    "- 仅保留两份综述在事实层面一致、互相印证、或均可由文献摘录共同支撑的论述；删除仅出现在其中一份的推断、分类或强调。\n" +
    "- 若某一论断仅模型 A 或仅模型 B 写出，必须删除。\n" +
    "- 保留 (DOI:…) / [n] / arXiv 等引用格式。\n" +
    "- 使用简体中文，可用二级标题 ##；须保留 **## 关键数据与指标**（若任一侧有则保留交集或更完整一侧的表格）；须保留 **## 间接参考与延伸线索** 与正文分离；篇幅可短于单篇综述。\n" +
    SYNTH_JSON_FOOTER +
    "- 若交集极少，先用一两句话说明共识较少，再列出仅有的交集要点。\n" +
    "- 不得编造文献中不存在的信息。" +
    (avoid
      ? "\n- 合并后的「共享部分」还须遵守下文【输出偏好】：弱化用户不喜欢的表述方式，但不牺牲可验证的共识事实。"
      : "") +
    patentMerge +
    avoid;

  const ms = Math.min(360_000, Math.max(30_000, Number(process.env.SYNTHESIS_TIMEOUT_MS) || 150_000));

  try {
    const result = await traceAsync(
      args.performanceTrace,
      arbitrator ? "synthesis.literature.C_arbitration" : "synthesis.literature.consensus",
      { model: args.provider?.model, streaming: typeof args.onTextDelta === "function" },
      () => generateText(args.provider, {
        timeoutMs: ms,
        temperature: arbitrator ? 0.12 : 0.15,
        maxTokens: arbitrator ? 8500 : 2200,
        system: arbitrator ? systemArb : systemMerge,
        messages: [
        {
          role: "user",
          content:
            `用户检索问题：${userQuery}\n\n` +
            (excerptPatentCount > 0
              ? `（检索摘录中含「类型:专利」${excerptPatentCount} 条，合并/仲裁终稿须保留专利公开号或 URL 等要点。）\n\n`
              : "") +
            `--- 模型 A 综述 ---\n${a}\n\n` +
            `--- 模型 B 综述 ---\n${b}\n\n` +
            (arbitrator ? "请输出经你仲裁后的**唯一终稿**综述正文。" : "请仅输出「共享部分」综述正文。"),
        },
        ],
        ...(typeof args.onTextDelta === "function" ? { onTextDelta: args.onTextDelta } : {}),
      }),
      (value) => ({ status: value?.status, outputChars: String(value?.text ?? "").length, error: value?.error }),
    );
    if (!result.ok) {
      console.error("[synthesize/consensus]", result.status, result.error);
      return { markdown: null, note: `synth_consensus:${result.error}` };
    }
    const text = result.text;
    if (!text) return { markdown: null, note: "synth_consensus:empty", plan: null, planNote: null };
    const fin = finalizeSynthesisMarkdown(text);
    return {
      markdown: fin.markdown,
      note: "synth_consensus:ok",
      plan: fin.plan,
      planNote: fin.planNote,
    };
  } catch (e) {
    console.error("[synthesize/consensus]", e);
    return { markdown: null, note: `synth_consensus_err:${e?.message || "unknown"}` };
  }
}

/** A/B use independent OpenAI-compatible providers; C uses native Gemini. */
function readTriSynthConfig(clientUrl, clientModelA, modelBHint) {
  return resolveTriProviders({
    chatCompletionsUrl: clientUrl,
    model: clientModelA,
    modelB: modelBHint,
  });
}

/**
 * 基于文献摘录生成文献综述（可选双模型共识；或三密钥 A/B 写、C 仲裁）
 * @param {{ userQuery: string; papers: object[]; apiKey?: string; model?: string; modelB?: string; chatCompletionsUrl?: string; personaSkill?: string }} p
 * @returns {Promise<{ markdown: string | null; plan: object | null; planNote: string | null; note: string; synthesisModels?: object }>}
 */
export async function synthesizeFromPapers(p) {
  const triCfg = readTriSynthConfig(p.chatCompletionsUrl, p.model, p.modelB);
  const primary = resolvePrimaryProvider(p);
  if (!triCfg && !primary) {
    return { markdown: null, plan: null, planNote: null, note: "synth:no-llm-key" };
  }
  const papers = Array.isArray(p.papers) ? p.papers : [];
  if (!papers.length) {
    return { markdown: null, plan: null, planNote: null, note: "synth:no-papers" };
  }
  const excerptPatentCount = pickPapersForSynthesis(papers, 35).filter(isPatentPaper).length;
  const userQuery = String(p.userQuery ?? "").trim().slice(0, 8000);
  if (!userQuery) {
    return { markdown: null, plan: null, planNote: null, note: "synth:empty-query" };
  }

  const modelA = primary?.model || sanitizeModel(p.model);
  const modelB = resolveSecondaryModel(modelA, p.modelB);
  const avoidHint = String(p.outputAvoidanceHint ?? "").trim().slice(0, 2000);
  const convoHint = String(p.conversationContext ?? "").trim().slice(0, 2500);

  if (triCfg) {
    const base = {
      userQuery,
      papers,
      personaSkill: p.personaSkill,
      outputAvoidanceHint: avoidHint || undefined,
      conversationContext: convoHint || undefined,
      performanceTrace: p.performanceTrace,
    };
    const [ra, rb] = await Promise.all([
      runSingleSynthesisModel({ ...base, provider: triCfg.A }),
      runSingleSynthesisModel({ ...base, provider: triCfg.B }),
    ]);
    const synthesisModels = {
      modelA: triCfg.A.model,
      modelB: triCfg.B.model,
      modelC: triCfg.C.model,
      mode: "tri_arbitration",
    };

    if (!ra.markdown && !rb.markdown) {
      if (primary) {
        const fb = await synthesisFallbackWithTriKeys(base, primary, triCfg);
        return {
          markdown: fb.markdown,
          plan: fb.plan ?? null,
          planNote: fb.planNote ?? null,
          note: fb.markdown
            ? `synth:tri_fail_then_single:${ra.note}|${rb.note}·${fb.note}`
            : `synth:tri_fail:${ra.note}|${rb.note}·single:${fb.note}`,
          synthesisModels: { ...synthesisModels, mode: "tri_fallback_single" },
        };
      }
      const fb0 = await runSingleSynthesisModel({ ...base, provider: triCfg.A });
      return {
        markdown: fb0.markdown,
        plan: fb0.plan ?? null,
        planNote: fb0.planNote ?? null,
        note: fb0.markdown
          ? `synth:tri_fail_then_slot_a:${ra.note}|${rb.note}·${fb0.note}`
          : `synth:tri_fail:${ra.note}|${rb.note}·${fb0.note}`,
        synthesisModels: { ...synthesisModels, mode: "tri_fallback_slot_a_only" },
      };
    }
    if (!ra.markdown) {
      return {
        markdown: rb.markdown,
        plan: rb.plan ?? null,
        planNote: rb.planNote ?? null,
        note: `${rb.note}·synth:tri_fallback_b_only`,
        synthesisModels: { ...synthesisModels, mode: "tri_partial" },
      };
    }
    if (!rb.markdown) {
      return {
        markdown: ra.markdown,
        plan: ra.plan ?? null,
        planNote: ra.planNote ?? null,
        note: `${ra.note}·synth:tri_fallback_a_only`,
        synthesisModels: { ...synthesisModels, mode: "tri_partial" },
      };
    }

    const merged = await mergeConsensusMarkdown({
      userQuery,
      markdownA: ra.markdown,
      markdownB: rb.markdown,
      provider: triCfg.C,
      personaSkill: p.personaSkill,
      outputAvoidanceHint: avoidHint || undefined,
      arbitratorMode: true,
      excerptPatentCount,
      onTextDelta: p.onTextDelta,
      performanceTrace: p.performanceTrace,
    });

    if (!merged.markdown) {
      const pick =
        (ra.markdown?.length || 0) >= (rb.markdown?.length || 0) ? ra.markdown : rb.markdown;
      if (pick && primary) {
        const fb = await synthesisFallbackWithTriKeys(base, primary, triCfg);
        if (fb.markdown) {
          return {
            markdown: fb.markdown,
            plan: fb.plan ?? pickBranchPlan(ra, rb),
            planNote: fb.planNote ?? merged.planNote ?? null,
            note: `synth:tri_arb_failed_then_single:${merged.note}·${fb.note}`,
            synthesisModels: { ...synthesisModels, mode: "tri_fallback_single_after_arb" },
          };
        }
      }
      if (pick) {
        const useRa = pick === ra.markdown;
        return {
          markdown: pick,
          plan: (useRa ? ra.plan : rb.plan) ?? pickBranchPlan(ra, rb),
          planNote: (useRa ? ra.planNote : rb.planNote) ?? null,
          note: `synth:tri_arb_failed_use_longer_branch:${merged.note}`,
          synthesisModels: { ...synthesisModels, mode: "tri_partial_no_arb" },
        };
      }
      return {
        markdown: null,
        plan: null,
        planNote: null,
        note: `synth:tri_arbitration_failed:${merged.note}`,
        synthesisModels,
      };
    }

    return {
      markdown: merged.markdown,
      plan: merged.plan ?? pickBranchPlan(ra, rb),
      planNote: merged.planNote ?? null,
      note: "synth:tri_arbitration_ok",
      synthesisModels,
    };
  }

  const base = {
    userQuery,
    papers,
    personaSkill: p.personaSkill,
    outputAvoidanceHint: avoidHint || undefined,
    conversationContext: convoHint || undefined,
    performanceTrace: p.performanceTrace,
  };

  if (!modelB) {
    const one = await runSingleSynthesisModel({
      ...base,
      provider: primary,
      onTextDelta: p.onTextDelta,
    });
    return {
      markdown: one.markdown,
      plan: one.plan ?? null,
      planNote: one.planNote ?? null,
      note: one.note,
      synthesisModels: { modelA, modelB: null, mode: "single" },
    };
  }

  const providerB = withProviderModel(primary, modelB, "B");
  const [ra, rb] = await Promise.all([
    runSingleSynthesisModel({ ...base, provider: primary }),
    runSingleSynthesisModel({ ...base, provider: providerB }),
  ]);

  const synthesisModels = { modelA, modelB, mode: "dual_consensus" };

  if (!ra.markdown && !rb.markdown) {
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: `synth:dual_fail:${ra.note}|${rb.note}`,
      synthesisModels,
    };
  }
  if (!ra.markdown) {
    return {
      markdown: rb.markdown,
      plan: rb.plan ?? null,
      planNote: rb.planNote ?? null,
      note: `${rb.note}·synth:dual_fallback_b_only`,
      synthesisModels: { ...synthesisModels, mode: "dual_partial" },
    };
  }
  if (!rb.markdown) {
    return {
      markdown: ra.markdown,
      plan: ra.plan ?? null,
      planNote: ra.planNote ?? null,
      note: `${ra.note}·synth:dual_fallback_a_only`,
      synthesisModels: { ...synthesisModels, mode: "dual_partial" },
    };
  }

  const merged = await mergeConsensusMarkdown({
    userQuery,
    markdownA: ra.markdown,
    markdownB: rb.markdown,
    provider: primary,
    personaSkill: p.personaSkill,
    outputAvoidanceHint: avoidHint || undefined,
    arbitratorMode: false,
    excerptPatentCount,
    onTextDelta: p.onTextDelta,
    performanceTrace: p.performanceTrace,
  });

  if (!merged.markdown) {
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: `synth:dual_consensus_failed:${merged.note}`,
      synthesisModels,
    };
  }

  return {
    markdown: merged.markdown,
    plan: merged.plan ?? pickBranchPlan(ra, rb),
    planNote: merged.planNote ?? null,
    note: "synth:dual_consensus_ok",
    synthesisModels,
  };
}
