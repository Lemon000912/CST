/**
 * 网页渠道：模型 A/B 独立生成联网回答，模型 C 仲裁并输出唯一终稿。
 */
import { sanitizeModel, defaultModel } from "./rewrite.js";
import {
  resolvePrimaryProvider,
  resolveTriProviderStatus,
  withProviderModel,
} from "./llmProviders.js";
import { generateText } from "./llmClient.js";
import { extractPatentNumberFromPaper } from "./patentNumber.js";
import {
  pickWebPatentPapersForSynthesis,
  buildWebAnswerUserPrompt,
  buildWebAnswerTokens,
  scoreWebPaperForAnswer,
} from "./webRelevance.js";
import {
  WEB_JSON_FOOTER,
  WEB_MARKDOWN_DATA_SECTION,
  finalizeSynthesisMarkdown,
} from "./synthesisExtract.js";
import { attachmentSynthMinChars } from "./synthesizeAttachment.js";
import { extractCoreSearchQuery } from "./searchQueryNormalize.js";
import { traceAsync } from "./performanceTrace.js";

function webDirectFallbackEnabled() {
  const v = String(process.env.WEB_DIRECT_FALLBACK ?? "0").trim();
  return v === "1" || v.toLowerCase() === "true";
}

function isPatentPaper(p) {
  const s = String(p?.source ?? "");
  return s === "ddg_patent" || s === "openalex_patent";
}

function isWebPaper(p) {
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

function excerptMaxForPaper(p) {
  if (String(p?.webFetchNote ?? "") === "fetched") {
    return Math.min(4000, Math.max(1500, Number(process.env.WEB_SYNTH_EXCERPT_FETCHED) || 3200));
  }
  return Math.min(2000, Math.max(600, Number(process.env.WEB_SYNTH_EXCERPT_SNIPPET) || 1200));
}

function paperBlock(p, idx) {
  const title = String(p.title ?? "").slice(0, 220);
  const src = String(p.source ?? "");
  const absU = String(p.absUrl ?? "").trim();
  const abst = String(p.summary ?? p.abstract ?? "").slice(0, excerptMaxForPaper(p));
  const fetchTag =
    String(p.webFetchNote ?? "") === "fetched"
      ? "（已抓取网页正文）"
      : String(p.webFetchNote ?? "").trim()
        ? `（抓取:${String(p.webFetchNote).slice(0, 40)}）`
        : "";
  const typeTag = isPatentPaper(p) ? "专利" : "网页";
  let idLine = absU ? `URL: ${absU}` : "（无链接）";
  if (isPatentPaper(p)) {
    const pn = String(p.patentNumber ?? "").trim() || extractPatentNumberFromPaper(p);
    if (pn) idLine = `专利号: ${pn}${absU ? ` | ${absU}` : ""}`;
  }
  return `[${idx}] 类型:${typeTag}${fetchTag} | ${idLine}\n标题: ${title}\n摘录: ${abst}`;
}

const WEB_ANSWER_SYSTEM =
  "你是「全网智能搜索」助手，输出应像 DeepSeek 联网问答：结构清晰、分板块、带引用角标，用户一眼能读懂。\n\n" +
  "【版式 · 必须遵守】\n" +
  "1) 首段 2～4 句：直接回答核心问题；写清主体全称、股票代码/注册地等（若有摘录）；句末 **[n]**。\n" +
  "2) 正文用 **## 二级标题** 分业务板块（企业/产品类示例：## 💊 营养品、## 🌸 香精香料、## 🧪 新材料）；标题下用 **- 无序列表** 列具体产品线/品种/应用，子项可缩进一层。\n" +
  "3) 每个关键事实句末 **[n]**（与摘录序号一致）；禁止大段无引用罗列；禁止「根据检索」「综上所述」「直接回答」等套话。\n" +
  "4) **严禁跑题**：不得用旅游、景点攻略、城市概况、政府门户写正文；企业问法下摘录不匹配时，首段写「当前摘录与问题不匹配」+「未在检索摘录中找到：…」。\n" +
  "5) 名称消歧：如「宁波新合成」对应「浙江新和成/NHU/002001」，首段先说明对应关系再写业务。\n" +
  "6) 弱相关仅文末「## 间接参考」，每条≤2句且标【间接】。\n" +
  "7) **严禁编造**：摘录未出现的公司全称、股票代码、注册资本、营收、产能、产品型号、标准号、日期一律不得写入；摘录互相矛盾时以**更权威/更具体**的一条为准并标注 [n]。\n" +
  "8) 不确定时写「摘录未明确」并列入「未在检索摘录中找到：…」，禁止用猜测填补。" +
  WEB_MARKDOWN_DATA_SECTION +
  WEB_JSON_FOOTER;

const WEB_DIRECT_SYSTEM =
  "你是联网问答助手。当前轮次「实时网页检索」未返回可用摘录（可能因网络或搜索引擎限制）。\n\n" +
  "请仍用可靠常识**直接回答**用户问题：\n" +
  "- 首句说明：以下为参考性回答，未附本轮检索摘录，具体参数/选型请以标准、产品说明或实验为准。\n" +
  "- 用 **## 二级标题** + 列表组织；材料/技术类写清类别、典型用途、优缺点。\n" +
  "- 禁止编造具体企业财务、产能、未给出的精确数值；不要写「根据检索」「综上所述」。\n" +
  "- 不要输出与问题无关的语言学、游戏、地图类内容。" +
  WEB_JSON_FOOTER;

const WEB_ARBITRATE_2_SYSTEM =
  "你是模型 C 仲裁编辑。比较模型 A/B 两份独立联网回答并输出**唯一终稿**，版式对齐 DeepSeek 智能搜索风格。\n\n" +
  "规则：\n" +
  "- **删除**旅游、城市百科、政府门户等跑题段；企业/产品问法下不得保留纯旅游内容。\n" +
  "- 保留有 **[n]** 支撑且一致的论述；合并去重；保留全部引用编号。\n" +
  "- 终稿结构：首段结论 → 多个 **## 板块标题**（可用 emoji）→ 列表化产品/业务要点；句末 **[n]**。\n" +
  "- 若草稿均跑题：终稿仅「摘录不匹配」+「未在检索摘录中找到」列表。\n" +
  "- 须保留 **## 关键数据与指标** 表（合并数值，去重）。" +
  WEB_JSON_FOOTER;

function readTriProviderStatus(clientUrl, clientModelA, modelBHint) {
  return resolveTriProviderStatus({
    chatCompletionsUrl: clientUrl,
    model: clientModelA,
    modelB: modelBHint,
  });
}

function unavailableWebAnswer(note) {
  return { markdown: null, note, plan: null, planNote: null, usage: null };
}

const TOKEN_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "totalTokens",
];

function addTokenUsage(...items) {
  const usages = items.filter((item) => item && typeof item === "object");
  if (!usages.length) return null;
  const total = {};
  for (const field of TOKEN_USAGE_FIELDS) {
    const values = usages.map((usage) => Number(usage[field])).filter(Number.isFinite);
    if (values.length) total[field] = values.reduce((sum, value) => sum + value, 0);
  }
  return Object.keys(total).length ? total : null;
}

function buildLlmUsage(slots) {
  const populated = Object.fromEntries(
    Object.entries(slots || {}).filter(([, usage]) => usage && typeof usage === "object"),
  );
  const total = addTokenUsage(...Object.values(populated));
  return total ? { slots: populated, total } : null;
}

function emptyWebAnswerDrafts(notes = {}) {
  return {
    modelA: null,
    modelB: null,
    modelC: null,
    noteA: notes.A || "web_answer:not_run",
    noteB: notes.B || "web_answer:not_run",
    noteC: notes.C || "web_answer:not_run",
  };
}

function pickWebPlan(...branches) {
  let best = null;
  let bestN = -1;
  for (const b of branches) {
    const n = Array.isArray(b?.plan?.extractedData) ? b.plan.extractedData.length : 0;
    if (n > bestN) {
      bestN = n;
      best = b.plan;
    }
  }
  if (best) return best;
  for (const b of branches) {
    if (b?.plan) return b.plan;
  }
  return null;
}

function webTriConcurrency() {
  const n = Number(process.env.WEB_TRI_CONCURRENCY);
  if (Number.isFinite(n) && n >= 1) return Math.min(2, Math.floor(n));
  return 2;
}

function webTriMode() {
  const m = String(process.env.WEB_TRI_MODE ?? "tri").trim().toLowerCase();
  return m === "single" ? "single" : "tri";
}

function speculativeWebStreamEnabled() {
  return String(process.env.WEB_STREAM_SPECULATIVE ?? "1").trim() !== "0";
}

function resolveWebFallbackModel(primary) {
  return sanitizeModel(primary || defaultModel());
}

function isRetriableHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function safeNetworkErrorCode(result) {
  const code = String(result?.exception?.cause?.code ?? result?.exception?.code ?? "").trim();
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "";
}

function isRetriableLlmFailure(result) {
  if (isRetriableHttpStatus(result?.status)) return true;
  if (result?.status !== 0 || result?.streamed) return false;
  const detail = `${result?.error ?? ""} ${safeNetworkErrorCode(result)}`;
  return /fetch failed|timeout|ECONN|EAI_AGAIN|ETIMEDOUT|UND_ERR|ENETUNREACH|EHOSTUNREACH/i.test(detail);
}

function safeUpstreamErrorStatus(result) {
  const status = String(result?.json?.error?.status ?? "").trim();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(status) ? status : "";
}

function webAnswerQualityIssue(markdown) {
  const text = String(markdown ?? "").trim();
  if (!text) return "empty";
  const compact = text.replace(/\s+/g, "");
  const chineseChars = compact.match(/[㐀-鿿]/g)?.length || 0;
  const hasStructure = /(^|\n)#{1,3}\s+\S/m.test(text) || /(^|\n)\s*[-*]\s+\S/m.test(text);
  if (compact.length < 120) return "too_short";
  if (chineseChars < 20 || chineseChars / Math.max(1, compact.length) < 0.08) return "non_chinese";
  if (!hasStructure) return "unstructured";
  return "";
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function synthesisTimeoutMs() {
  return Math.min(360_000, Math.max(25_000, Number(process.env.SYNTHESIS_TIMEOUT_MS) || 180_000));
}

function webAnswerMaxTokens(lite) {
  const cap = lite ? 3200 : Number(process.env.WEB_ANSWER_MAX_TOKENS) || 4200;
  return Math.min(8000, Math.max(lite ? 2200 : 3200, cap));
}

function prependDirectDisclaimer(md) {
  const t = String(md ?? "").trim();
  if (!t) return t;
  return `> 说明：以下回答未附本轮检索摘录支撑，仅供参考。\n\n${t}`;
}

function buildNoSourcesMarkdown(coreQuery) {
  const q = String(coreQuery || "该问题").slice(0, 200);
  return `## 检索说明\n\n未找到与「${q}」强相关的网页/专利摘录。请尝试更换关键词、缩短问题，或改用「数据库优先」。`;
}

/** 网关 504 时缩短摘录与提问，减轻单次请求体积 */
function buildLiteWebAnswerBase(base, papers, userQuery, coreQuery, conversationContext, ultra) {
  const maxP = ultra
    ? Math.min(4, Math.max(2, Number(process.env.WEB_ULTRA_LITE_MAX_PAPERS) || 3))
    : Math.min(8, Math.max(3, Number(process.env.WEB_LITE_MAX_PAPERS) || 6));
  const litePapers = papers.slice(0, maxP);
  const excerptList = litePapers.map((x, i) => paperBlock(x, i + 1)).join("\n\n---\n\n");
  const core = String(coreQuery || userQuery).slice(0, ultra ? 400 : 600);
  const userPromptBody = buildWebAnswerUserPrompt({
    userQuery: core.slice(0, ultra ? 800 : 1200),
    conversationContext: ultra ? String(conversationContext ?? "").slice(0, 800) : String(conversationContext ?? "").slice(0, 1200),
    coreQuery: core,
    excerptList: excerptList.slice(0, ultra ? 9000 : 14_000),
    usedCount: litePapers.length,
    totalCount: base.totalCount ?? litePapers.length,
    filteredOut: base.filteredOut ?? 0,
  });
  return {
    ...base,
    userQuery: core.slice(0, ultra ? 1200 : 2000),
    excerptList: excerptList.slice(0, ultra ? 9000 : 14_000),
    userPromptBody,
    usedCount: litePapers.length,
  };
}

async function runWebAnswerSlots(slots, concurrency) {
  const runSlot = (slot) =>
    slot.provider
      ? runSingleWebAnswer(slot)
      : Promise.resolve(unavailableWebAnswer("web_answer:provider_not_configured"));
  if (concurrency >= 2) {
    return Promise.all(slots.map(runSlot));
  }
  const out = [];
  for (const slot of slots) {
    out.push(await runSlot(slot));
  }
  return out;
}

/**
 * @param {{ userQuery: string; excerptList: string; apiKey: string; model: string; chatCompletionsUrl: string; personaSkill?: string; outputAvoidanceHint?: string; slot?: string }} args
 */
/** 检索摘录不可用时的常识作答（仍走 LLM，保证基础问题有回答） */
async function runWebDirectKnowledgeAnswer(args) {
  const userQuery = String(args.userQuery ?? "").trim().slice(0, 6000);
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = String(args.outputAvoidanceHint ?? "").trim()
    ? `\n\n【输出偏好】\n${String(args.outputAvoidanceHint).slice(0, 2000)}`
    : "";
  try {
    const result = await traceAsync(
      args.performanceTrace,
      "synthesis.web.direct",
      { slot: args.slot || "direct", model: args.provider?.model, streaming: typeof args.onTextDelta === "function" },
      () => generateText(args.provider, {
        timeoutMs: synthesisTimeoutMs(),
        temperature: 0.18,
        maxTokens: webAnswerMaxTokens(true),
        system: skillPrefix + WEB_DIRECT_SYSTEM + avoid,
        messages: [{ role: "user", content: `用户问题：\n${userQuery}\n\n请直接作答。` }],
        ...(typeof args.onTextDelta === "function" ? { onTextDelta: args.onTextDelta } : {}),
      }),
      (value) => ({ status: value?.status, outputChars: String(value?.text ?? "").length, error: value?.error }),
    );
    if (!result.ok) {
      return { markdown: null, note: `web_direct:${result.error}`, plan: null, planNote: null, usage: result.usage };
    }
    const text = result.text;
    if (!text) return { markdown: null, note: "web_direct:empty", plan: null, planNote: null, usage: result.usage };
    const fin = finalizeSynthesisMarkdown(text);
    return {
      markdown: fin.markdown,
      note: `web_direct:ok:${args.slot || "B"}`,
      plan: fin.plan,
      planNote: fin.planNote,
      usage: result.usage,
    };
  } catch (e) {
    return { markdown: null, note: `web_direct_err:${e?.message || "unknown"}`, plan: null, planNote: null, usage: null };
  }
}

function isLowQualityWebPick(papers, userQuery, coreQuery) {
  if (!papers?.length) return true;
  const tokens = buildWebAnswerTokens(userQuery);
  let bad = 0;
  for (const p of papers) {
    const t = `${p.title || ""} ${p.summary || ""}`;
    if (/什么[\s\S]{0,8}(词语|意思|汉典)|值得买.*兴趣消费|4399|快手\s*app|百度地图\s*-\s*卫星/i.test(t)) {
      bad++;
      continue;
    }
    if (scoreWebPaperForAnswer(p, tokens, coreQuery, userQuery) < 10) bad++;
  }
  return bad >= Math.max(1, Math.ceil(papers.length * 0.6));
}

async function runSingleWebAnswer(args) {
  const userQuery = String(args.userQuery ?? "").trim().slice(0, 6000);
  const list = String(args.excerptList ?? "").trim().slice(0, args.lite ? 14_000 : 32_000);
  const userPrompt =
    args.userPromptBody ||
    buildWebAnswerUserPrompt({
      userQuery,
      coreQuery: args.coreQuery || userQuery,
      excerptList: list,
      usedCount: args.usedCount ?? 0,
      totalCount: args.totalCount ?? 0,
      filteredOut: args.filteredOut ?? 0,
    });
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = String(args.outputAvoidanceHint ?? "").trim()
    ? `\n\n【输出偏好】\n${String(args.outputAvoidanceHint).slice(0, 2000)}`
    : "";

  const maxAttempts = Number.isFinite(Number(args.maxAttempts))
    ? Math.min(3, Math.max(1, Math.floor(Number(args.maxAttempts))))
    : Math.min(3, Math.max(1, Number(process.env.WEB_ANSWER_RETRIES) || 2));
  const provider = args.provider;
  const model = provider?.model;
  let lastNote = "web_answer:empty";
  let usage = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await traceAsync(
        args.performanceTrace,
        `synthesis.web.${String(args.slot || "unknown").replace(/[^a-z0-9_-]/gi, "_")}.attempt_${attempt}`,
        { model, lite: Boolean(args.lite), streaming: typeof args.onTextDelta === "function" },
        () => generateText(provider, {
          timeoutMs: synthesisTimeoutMs(),
          temperature: 0.12,
          maxTokens: webAnswerMaxTokens(Boolean(args.lite)),
          system: skillPrefix + WEB_ANSWER_SYSTEM + avoid,
          messages: [
            {
              role: "user",
              content:
                "【语言与完整性要求】必须使用简体中文输出完整正文；不得仅返回英文检索片段、引用列表、数据残句或思考过程。请先直接回答，再按二级标题和列表展开。\n\n" +
                `【模型槽位】${args.slot || "?"}${attempt > 1 ? ` · 重试${attempt}` : ""}\n\n${userPrompt}`,
            },
          ],
          ...(typeof args.onTextDelta === "function" ? { onTextDelta: args.onTextDelta } : {}),
        }),
        (value) => ({ status: value?.status, outputChars: String(value?.text ?? "").length, error: value?.error }),
      );
      usage = addTokenUsage(usage, result.usage);
      if (!result.ok) {
        const upstreamStatus = safeUpstreamErrorStatus(result);
        const networkCode = safeNetworkErrorCode(result);
        lastNote = `web_answer:${result.error}${upstreamStatus ? `:${upstreamStatus}` : networkCode ? `:${networkCode}` : ""}`;
        const modelMissing = result.status === 503 && /model_not_found|no available channel/i.test(result.errorBody);
        console.error("[webTriAnswer]", args.slot, model, result.status, result.error, upstreamStatus || networkCode || undefined);
        if ((isRetriableLlmFailure(result) || modelMissing) && attempt < maxAttempts) {
          await sleepMs(result.status === 504 ? 400 * attempt : 800 * attempt);
          continue;
        }
        return { markdown: null, note: lastNote, plan: null, planNote: null, usage };
      }
      const text = result.text;
      if (!text) {
        lastNote = "web_answer:empty";
        continue;
      }
      const fin = finalizeSynthesisMarkdown(text);
      const qualityIssue = webAnswerQualityIssue(fin.markdown);
      if (qualityIssue) {
        lastNote = `web_answer:${qualityIssue}`;
        console.warn("[webTriAnswer] low quality", args.slot, model, qualityIssue);
        if (attempt < maxAttempts) {
          await sleepMs(400 * attempt);
          continue;
        }
        return { markdown: null, note: lastNote, plan: null, planNote: null, usage };
      }
      return {
        markdown: fin.markdown,
        note: attempt > 1 ? `web_answer:ok_retry_${attempt}` : "web_answer:ok",
        plan: fin.plan,
        planNote: fin.planNote,
        usage,
      };
    } catch (e) {
      lastNote = `web_answer_err:${String(e?.message || e).slice(0, 80)}`;
      if (attempt < maxAttempts) {
        await sleepMs(800 * attempt);
        continue;
      }
    }
  }
  return { markdown: null, note: lastNote, plan: null, planNote: null, usage };
}

async function runWebAnswerLiteFallback(args) {
  const liteBase = buildLiteWebAnswerBase(
    args.base,
    args.papers,
    args.userQuery,
    args.coreQuery,
    args.conversationContext,
  );
  const model = resolveWebFallbackModel(args.provider?.model);
  const provider = withProviderModel(args.provider, model);
  if (!provider) return { markdown: null, note: "web_lite:no-key", plan: null, planNote: null };
  console.warn("[webTriAnswer] lite fallback with model", model, "papers", liteBase.usedCount);
  return runSingleWebAnswer({
    ...liteBase,
    provider,
    slot: "lite",
    lite: true,
    personaSkill: args.personaSkill,
    outputAvoidanceHint: args.outputAvoidanceHint,
    onTextDelta: args.onTextDelta,
  });
}

async function arbitrateTwoWebAnswers(args) {
  const userQuery = String(args.userQuery ?? "").trim().slice(0, 6000);
  const coreQuery = String(args.coreQuery ?? userQuery).trim().slice(0, 800);
  const a = String(args.markdownA ?? "").trim().slice(0, 10_000);
  const b = String(args.markdownB ?? "").trim().slice(0, 10_000);
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = String(args.outputAvoidanceHint ?? "").trim()
    ? `\n\n【输出偏好】\n${String(args.outputAvoidanceHint).slice(0, 2000)}`
    : "";

  try {
    const result = await traceAsync(
      args.performanceTrace,
      "synthesis.web.C_arbitration",
      { model: args.provider?.model, streaming: typeof args.onTextDelta === "function" },
      () => generateText(args.provider, {
        timeoutMs: synthesisTimeoutMs(),
        temperature: 0.1,
        maxTokens: Math.min(8000, Math.max(4500, Number(process.env.WEB_MERGE_MAX_TOKENS) || 6000)),
        system: skillPrefix + WEB_ARBITRATE_2_SYSTEM + avoid,
        messages: [
          {
            role: "user",
            content:
              `【核心问题】\n${coreQuery}\n\n` +
              `--- 模型 A 回答 ---\n${a}\n\n` +
              `--- 模型 B 回答 ---\n${b}\n\n` +
              "请以模型 C 仲裁者身份，使用简体中文输出经比较、去重、**剔除跑题**后的完整唯一终稿；不得只返回英文资料片段、引用列表或数据残句。",
          },
        ],
        ...(typeof args.onTextDelta === "function" ? { onTextDelta: args.onTextDelta } : {}),
      }),
      (value) => ({ status: value?.status, outputChars: String(value?.text ?? "").length, error: value?.error }),
    );
    if (!result.ok) {
      const upstreamStatus = safeUpstreamErrorStatus(result);
      return {
        markdown: null,
        note: `web_arbitration:${result.error}${upstreamStatus ? `:${upstreamStatus}` : ""}`,
        usage: result.usage,
      };
    }
    const text = result.text;
    if (!text) return { markdown: null, note: "web_arbitration:empty", plan: null, planNote: null, usage: result.usage };
    const fin = finalizeSynthesisMarkdown(text);
    const qualityIssue = webAnswerQualityIssue(fin.markdown);
    if (qualityIssue) {
      return {
        markdown: null,
        note: `web_arbitration:${qualityIssue}`,
        plan: null,
        planNote: null,
        usage: result.usage,
      };
    }
    return {
      markdown: fin.markdown,
      note: "web_arbitration:ok",
      plan: fin.plan,
      planNote: fin.planNote,
      usage: result.usage,
    };
  } catch (e) {
    return { markdown: null, note: `web_arbitration_err:${e?.message || "unknown"}`, usage: null };
  }
}

/**
 * @param {{ userQuery: string; effectiveQuery?: string; papers: object[]; apiKey?: string; model?: string; modelB?: string; chatCompletionsUrl?: string; personaSkill?: string; outputAvoidanceHint?: string }} p
 */
export async function synthesizeWebTriAnswer(p) {
  const primary = resolvePrimaryProvider(p);
  const triStatus = readTriProviderStatus(p.chatCompletionsUrl, p.model, p.modelB);
  const triProviders = triStatus.providers;
  const availableProviders = Object.values(triProviders).filter(Boolean);
  if (!availableProviders.length && !primary) {
    return {
      markdown: null,
      note: "web_tri:no-llm-key|missing=A,B,C",
      synthesisModels: { mode: "web_tri_config_incomplete" },
      webAnswerDrafts: emptyWebAnswerDrafts({
        A: "web_answer:provider_not_configured",
        B: "web_answer:provider_not_configured",
        C: "web_answer:provider_not_configured",
      }),
    };
  }

  const userQueryRaw = String(p.userQuery ?? "").trim().slice(0, 6000);
  const userQuery = extractCoreSearchQuery(userQueryRaw) || userQueryRaw;
  if (!userQuery) {
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: "web_tri:empty-query",
      synthesisModels: { mode: "web_tri_empty_query" },
      webAnswerDrafts: emptyWebAnswerDrafts({
        A: "web_answer:not_run_empty_query",
        B: "web_answer:not_run_empty_query",
        C: "web_answer:not_run_empty_query",
      }),
    };
  }

  const picked = pickWebPatentPapersForSynthesis(
    p.papers,
    userQuery,
    Math.min(36, Math.max(18, Number(process.env.WEB_SYNTH_PICK_MAX) || 30)),
    p.effectiveQuery,
  );
  let papers = picked.papers;
  if (!papers.length && Array.isArray(p.papers) && p.papers.length) {
    papers = p.papers.filter((x) => isWebPaper(x) || isPatentPaper(x)).slice(0, 8);
  }

  const sourceNoteEarly = papers.length
    ? `sources=${papers.length}/${picked.totalIn}|filtered=${picked.filteredOut}`
    : `sources=0/${picked.totalIn}|filtered=${picked.filteredOut}`;

  const directProvider = triProviders.A || triProviders.B || primary || null;
  const lowQualityPick = isLowQualityWebPick(papers, userQuery, picked.coreQuery);
  const hasRichAttachment =
    String(p.attachmentContext ?? "").trim().length >= attachmentSynthMinChars();
  if (
    directProvider &&
    webDirectFallbackEnabled() &&
    lowQualityPick &&
    !hasRichAttachment &&
    !isBookIntentQuery(userQuery)
  ) {
    const dr = await runWebDirectKnowledgeAnswer({
      userQuery,
      provider: withProviderModel(directProvider, resolveWebFallbackModel(directProvider.model)),
      personaSkill: p.personaSkill,
      outputAvoidanceHint: p.outputAvoidanceHint,
      slot: "direct",
      onTextDelta: p.onTextDelta,
      performanceTrace: p.performanceTrace,
    });
    if (dr.markdown) {
      return {
        markdown: prependDirectDisclaimer(dr.markdown),
        plan: dr.plan ?? null,
        planNote: dr.planNote ?? null,
        note: `web_tri:direct_knowledge:${dr.note}|${sourceNoteEarly}|pick_low_quality`,
        synthesisModels: { mode: "web_tri_direct_knowledge", modelA: directProvider?.model },
        llmUsage: buildLlmUsage({ direct: dr.usage }),
        webAnswerDrafts: {
          ...emptyWebAnswerDrafts({
            B: "web_answer:not_run_direct_fallback",
            C: "web_answer:not_run_direct_fallback",
          }),
          modelA: dr.markdown,
          noteA: dr.note,
        },
      };
    }
  }

  if (!papers.length) {
    if (directProvider && webDirectFallbackEnabled()) {
      const dr = await runWebDirectKnowledgeAnswer({
        userQuery,
        provider: withProviderModel(directProvider, resolveWebFallbackModel(directProvider.model)),
        personaSkill: p.personaSkill,
        outputAvoidanceHint: p.outputAvoidanceHint,
        slot: "direct",
        onTextDelta: p.onTextDelta,
        performanceTrace: p.performanceTrace,
      });
      if (dr.markdown) {
        return {
          markdown: prependDirectDisclaimer(dr.markdown),
          plan: dr.plan ?? null,
          planNote: dr.planNote ?? null,
          note: `web_tri:direct_knowledge:${dr.note}|${sourceNoteEarly}`,
          synthesisModels: { mode: "web_tri_direct_knowledge", modelA: directProvider?.model },
          llmUsage: buildLlmUsage({ direct: dr.usage }),
          webAnswerDrafts: {
            ...emptyWebAnswerDrafts({
              B: "web_answer:not_run_direct_fallback",
              C: "web_answer:not_run_direct_fallback",
            }),
            modelA: dr.markdown,
            noteA: dr.note,
          },
        };
      }
    }
    return {
      markdown: buildNoSourcesMarkdown(picked.coreQuery),
      plan: null,
      planNote: null,
      note: `web_tri:no-relevant-sources|${sourceNoteEarly}`,
      synthesisModels: { mode: "web_tri_no_sources" },
      webAnswerDrafts: emptyWebAnswerDrafts({
        A: "web_answer:not_run_no_relevant_sources",
        B: "web_answer:not_run_no_relevant_sources",
        C: "web_answer:not_run_no_relevant_sources",
      }),
    };
  }

  const excerptList = papers.map((x, i) => paperBlock(x, i + 1)).join("\n\n---\n\n");
  const userPromptBody = buildWebAnswerUserPrompt({
    userQuery,
    conversationContext: p.conversationContext,
    coreQuery: picked.coreQuery,
    excerptList,
    usedCount: papers.length,
    totalCount: picked.totalIn,
    filteredOut: picked.filteredOut,
  });
  const liteBase = buildLiteWebAnswerBase(
    {
      userQuery,
      coreQuery: picked.coreQuery,
      excerptList,
      userPromptBody,
      usedCount: papers.length,
      totalCount: picked.totalIn,
      filteredOut: picked.filteredOut,
      personaSkill: p.personaSkill,
      outputAvoidanceHint: p.outputAvoidanceHint,
    },
    papers,
    userQuery,
    picked.coreQuery,
    p.conversationContext,
  );
  const fullBase = {
    userQuery,
    coreQuery: picked.coreQuery,
    excerptList,
    userPromptBody,
    usedCount: papers.length,
    totalCount: picked.totalIn,
    filteredOut: picked.filteredOut,
    personaSkill: p.personaSkill,
    outputAvoidanceHint: p.outputAvoidanceHint,
    performanceTrace: p.performanceTrace,
  };
  const sourceNote = `sources=${papers.length}/${picked.totalIn}|filtered=${picked.filteredOut}`;

  const triMode = webTriMode();
  if (triMode === "single") {
    const singleProvider = triProviders.A || primary;
    const singleModel = resolveWebFallbackModel(singleProvider?.model);
    const selectedProvider = withProviderModel(singleProvider, singleModel);
    let one = selectedProvider
      ? await runSingleWebAnswer({
          ...liteBase,
          provider: selectedProvider,
          slot: "A-single",
          lite: true,
          onTextDelta: p.onTextDelta,
        })
      : unavailableWebAnswer("web_answer:provider_not_configured");
    if (!one.markdown && selectedProvider) {
      one = await runWebAnswerLiteFallback({
        base: liteBase,
        papers,
        userQuery,
        coreQuery: picked.coreQuery,
        conversationContext: p.conversationContext,
        provider: selectedProvider,
        personaSkill: p.personaSkill,
        outputAvoidanceHint: p.outputAvoidanceHint,
        onTextDelta: p.onTextDelta,
      });
    }
    const singleDrafts = {
      ...emptyWebAnswerDrafts({
        B: "web_answer:not_run_single_mode",
        C: "web_answer:not_run_single_mode",
      }),
      modelA: one.markdown,
      noteA: one.note,
    };
    return {
      markdown: one.markdown,
      plan: one.plan ?? null,
      planNote: one.planNote ?? null,
      note: `web_tri:single_${one.markdown ? "ok" : "failed"}:${one.note}|${sourceNote}`,
      synthesisModels: {
        mode: one.markdown ? "web_tri_single" : "web_tri_single_failed",
        modelA: singleModel,
      },
      llmUsage: buildLlmUsage({ A: one.usage }),
      webAnswerDrafts: singleDrafts,
    };
  }

  const base = fullBase;
  const modelA = triProviders.A?.model ?? null;
  const modelB = triProviders.B?.model ?? null;
  const modelC = triProviders.C?.model ?? null;
  const concurrency = webTriConcurrency();

  if (!triStatus.complete) {
    console.warn("[webTriAnswer] tri provider configuration incomplete", {
      missingSlots: triStatus.missingSlots,
      providers: triStatus.descriptions,
    });
  }

  // Streaming requests use a speculative C answer for a fast first token while
  // A/B independently build the drafts that the second C call will arbitrate.
  // Non-streaming requests retain the established A/B -> C sequence.
  let previewEmitted = false;
  const useSpeculativePreview =
    triStatus.complete &&
    speculativeWebStreamEnabled() &&
    typeof p.onTextDelta === "function";
  const previewPromise = useSpeculativePreview
    ? runSingleWebAnswer({
        ...base,
        provider: triProviders.C,
        slot: "C-preview",
        maxAttempts: 1,
        onTextDelta: (delta) => {
          previewEmitted = true;
          return p.onTextDelta(delta);
        },
      })
    : Promise.resolve(unavailableWebAnswer("web_preview:not_run"));
  const draftsPromise = runWebAnswerSlots(
    [
      { ...base, provider: triProviders.A, slot: "A" },
      { ...base, provider: triProviders.B, slot: "B" },
    ],
    concurrency,
  );
  const [preview, [ra, rb]] = await Promise.all([previewPromise, draftsPromise]);

  const drafts = {
    modelA: ra.markdown,
    modelB: rb.markdown,
    modelC: null,
    noteA: ra.note,
    noteB: rb.note,
    noteC: "web_answer:not_run_arbiter_only",
  };
  const draftUsage = {
    A: ra.usage,
    B: rb.usage,
    ...(useSpeculativePreview ? { preview: preview.usage } : {}),
  };

  const executionMode = (mode) =>
    triStatus.complete ? mode : `${mode}_config_incomplete`;
  const synthesisModels = {
    modelA,
    modelB,
    modelC,
    mode: executionMode("web_tri_3keys"),
  };

  const okAnswers = [ra, rb].filter((x) => x.markdown);
  if (!okAnswers.length) {
    const liteProvider = primary || triProviders.A || triProviders.B;
    const selectedLiteProvider = withProviderModel(
      liteProvider,
      resolveWebFallbackModel(liteProvider?.model),
    );
    const lite = selectedLiteProvider
      ? await runWebAnswerLiteFallback({
          base,
          papers,
          userQuery,
          coreQuery: picked.coreQuery,
          conversationContext: p.conversationContext,
          provider: selectedLiteProvider,
          personaSkill: p.personaSkill,
          outputAvoidanceHint: p.outputAvoidanceHint,
          onTextDelta: previewEmitted ? undefined : p.onTextDelta,
        })
      : unavailableWebAnswer("web_lite:provider_not_configured");
    if (lite.markdown) {
      return {
        markdown: lite.markdown,
        plan: lite.plan ?? null,
        planNote: lite.planNote ?? null,
        note: `web_tri:lite_fallback_ok:${lite.note}|${ra.note}|${rb.note}|${sourceNote}`,
        synthesisModels: {
          ...synthesisModels,
          mode: executionMode("web_tri_lite_fallback"),
        },
        llmUsage: buildLlmUsage({ ...draftUsage, lite: lite.usage }),
        webAnswerDrafts: drafts,
      };
    }
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: `web_tri:all_failed:${ra.note}|${rb.note}|${lite.note}|${sourceNote}`,
      synthesisModels,
      llmUsage: buildLlmUsage({ ...draftUsage, lite: lite.usage }),
      webAnswerDrafts: drafts,
    };
  }

  if (okAnswers.length === 1) {
    const one = okAnswers[0];
    return {
      markdown: one.markdown,
      plan: one.plan ?? null,
      planNote: one.planNote ?? null,
      note: `web_tri:single_ok:${ra.note}|${rb.note}|web_arbitration:not_run_single_draft`,
      synthesisModels: { ...synthesisModels, mode: executionMode("web_tri_partial_1") },
      llmUsage: buildLlmUsage(draftUsage),
      webAnswerDrafts: drafts,
    };
  }

  const arbitration = triProviders.C
    ? await arbitrateTwoWebAnswers({
        userQuery,
        coreQuery: picked.coreQuery,
        markdownA: ra.markdown,
        markdownB: rb.markdown,
        provider: triProviders.C,
        personaSkill: p.personaSkill,
        outputAvoidanceHint: p.outputAvoidanceHint,
        performanceTrace: p.performanceTrace,
        // If preview yielded nothing, preserve the regular final-C streaming path.
        onTextDelta: previewEmitted ? undefined : p.onTextDelta,
      })
    : unavailableWebAnswer("web_arbitration:provider_not_configured");

  if (arbitration.markdown) {
    return {
      markdown: arbitration.markdown,
      plan: arbitration.plan ?? pickWebPlan(ra, rb),
      planNote: arbitration.planNote ?? null,
      note: `web_tri:arbitration_ok:${arbitration.note}${useSpeculativePreview ? `|preview=${preview.note}` : ""}|${sourceNote}`,
      synthesisModels: {
        ...synthesisModels,
        mode: executionMode(useSpeculativePreview ? "web_tri_speculative_arbitration" : "web_tri_arbitration"),
      },
      llmUsage: buildLlmUsage({ ...draftUsage, C: arbitration.usage }),
      webAnswerDrafts: drafts,
    };
  }

  const longest = (rb.markdown?.length || 0) > (ra.markdown?.length || 0) ? rb : ra;
  return {
    markdown: longest.markdown,
    plan: longest.plan ?? pickWebPlan(ra, rb),
    planNote: longest.planNote ?? null,
    note: `web_tri:arbitration_failed_use_longest:${arbitration.note}|${sourceNote}`,
    synthesisModels: { ...synthesisModels, mode: executionMode("web_tri_fallback_longest") },
    llmUsage: buildLlmUsage({ ...draftUsage, C: arbitration.usage }),
    webAnswerDrafts: drafts,
  };
}
