/**
 * 网页渠道：三模型并行「联网问答式」作答 + 仲裁合并终稿（类似大模型全网搜索后综合回答）。
 */
import {
  resolveApiKey,
  resolveChatCompletionsUrl,
  sanitizeModel,
  safeHttpUrl,
  defaultModel,
} from "./rewrite.js";
import { extractPatentNumberFromPaper } from "./patentNumber.js";
import { resolveSecondaryModel } from "./synthesize.js";
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

const WEB_MERGE_3_SYSTEM =
  "你是仲裁编辑。合并模型 A/B/C 三份联网回答为**唯一终稿**，版式对齐 DeepSeek 智能搜索风格。\n\n" +
  "规则：\n" +
  "- **删除**旅游、城市百科、政府门户等跑题段；企业/产品问法下不得保留纯旅游内容。\n" +
  "- 保留有 **[n]** 支撑且一致的论述；合并去重；保留全部引用编号。\n" +
  "- 终稿结构：首段结论 → 多个 **## 板块标题**（可用 emoji）→ 列表化产品/业务要点；句末 **[n]**。\n" +
  "- 若草稿均跑题：终稿仅「摘录不匹配」+「未在检索摘录中找到」列表。\n" +
  "- 须保留 **## 关键数据与指标** 表（合并数值，去重）。" +
  WEB_JSON_FOOTER;

function readTriKeys(clientUrl, clientModelA, modelBHint) {
  const keyA = String(process.env.SYNTHESIS_API_KEY_A ?? "").trim();
  const keyB = String(process.env.SYNTHESIS_API_KEY_B ?? "").trim();
  const keyC = String(process.env.SYNTHESIS_API_KEY_C ?? "").trim();
  if (!keyA || !keyB || !keyC) return null;
  const urlBase = resolveChatCompletionsUrl(clientUrl);
  const urlA = safeHttpUrl(String(process.env.SYNTHESIS_CHAT_URL_A ?? "").trim()) || urlBase;
  const urlB = safeHttpUrl(String(process.env.SYNTHESIS_CHAT_URL_B ?? "").trim()) || urlBase;
  const urlC = safeHttpUrl(String(process.env.SYNTHESIS_CHAT_URL_C ?? "").trim()) || urlBase;
  const modelA = sanitizeModel(
    String(process.env.SYNTHESIS_MODEL_A ?? "").trim() || String(clientModelA ?? "").trim() || defaultModel(),
  );
  const modelB = sanitizeModel(
    String(process.env.SYNTHESIS_MODEL_B ?? "").trim() ||
      String(modelBHint ?? "").trim() ||
      String(process.env.LLM_MODEL_B ?? "").trim() ||
      defaultModel(),
  );
  const modelC = sanitizeModel(
    String(process.env.SYNTHESIS_MODEL_C ?? "").trim() || defaultModel(),
  );
  return { keyA, keyB, keyC, urlA, urlB, urlC, modelA, modelB, modelC };
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

function resolveTripleModels(clientModel, modelBHint) {
  const modelA = sanitizeModel(String(clientModel ?? "").trim() || defaultModel());
  const modelB = sanitizeModel(
    resolveSecondaryModel(modelA, modelBHint) ||
      String(process.env.LLM_MODEL_B ?? "").trim() ||
      defaultModel(),
  );
  const modelC = sanitizeModel(
    String(process.env.LLM_MODEL_C ?? process.env.SYNTHESIS_MODEL_C ?? "").trim() || defaultModel(),
  );
  return { modelA, modelB, modelC };
}

function webTriConcurrency() {
  const n = Number(process.env.WEB_TRI_CONCURRENCY);
  if (Number.isFinite(n) && n >= 1) return Math.min(3, Math.floor(n));
  return 1;
}

function webTriMode() {
  const m = String(process.env.WEB_TRI_MODE ?? "single").trim().toLowerCase();
  return m === "tri" || m === "3" || m === "triple" ? "tri" : "single";
}

function webModelCandidates(primary) {
  const fromEnv = String(process.env.WEB_ANSWER_MODEL_FALLBACK ?? "").trim();
  const list = fromEnv
    ? fromEnv.split(/[,;|]/).map((x) => sanitizeModel(x.trim())).filter(Boolean)
    : [
        "gpt-5.4",
        "gpt-5.5",
        sanitizeModel(String(process.env.SYNTHESIS_MODEL_B ?? "").trim()),
        sanitizeModel(String(process.env.SYNTHESIS_MODEL_A ?? "").trim()),
        sanitizeModel(String(process.env.SYNTHESIS_MODEL_C ?? "").trim()),
      ];
  const pri = sanitizeModel(primary || defaultModel());
  const out = [];
  const seen = new Set();
  const fastFirst = !/^(0|false|off|no)$/i.test(String(process.env.WEB_ANSWER_FAST_MODEL ?? "1").trim());
  const ordered = fastFirst && pri === "gpt-5.5" ? ["gpt-5.4", pri, ...list] : [pri, ...list];
  for (const m of ordered) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out.length ? out : ["gpt-5.4"];
}

function resolveWebFallbackModel(primary) {
  const cands = webModelCandidates(primary);
  return cands[0] || "gpt-5.4";
}

function isRetriableHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
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
  if (concurrency >= 3) {
    return Promise.all(slots.map((s) => runSingleWebAnswer(s)));
  }
  const out = [];
  for (const s of slots) {
    out.push(await runSingleWebAnswer(s));
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
  const controller = new AbortController();
  const ms = synthesisTimeoutMs();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(args.chatCompletionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: args.model,
        temperature: 0.18,
        max_tokens: webAnswerMaxTokens(true),
        messages: [
          { role: "system", content: skillPrefix + WEB_DIRECT_SYSTEM + avoid },
          { role: "user", content: `用户问题：\n${userQuery}\n\n请直接作答。` },
        ],
      }),
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      return { markdown: null, note: `web_direct:http_${r.status}`, plan: null, planNote: null };
    }
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return { markdown: null, note: "web_direct:empty", plan: null, planNote: null };
    const fin = finalizeSynthesisMarkdown(text);
    return {
      markdown: fin.markdown,
      note: `web_direct:ok:${args.slot || "B"}`,
      plan: fin.plan,
      planNote: fin.planNote,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    return { markdown: null, note: `web_direct_err:${e?.message || "unknown"}`, plan: null, planNote: null };
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

  const maxAttempts = Math.min(3, Math.max(1, Number(process.env.WEB_ANSWER_RETRIES) || 2));
  const modelCandidates = webModelCandidates(args.model);
  let lastNote = "web_answer:empty";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const model = modelCandidates[Math.min(modelCandidates.length - 1, attempt - 1)] || args.model;
    const controller = new AbortController();
    const ms = synthesisTimeoutMs();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
      const r = await fetch(args.chatCompletionsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.12,
          max_tokens: webAnswerMaxTokens(Boolean(args.lite)),
          messages: [
            { role: "system", content: skillPrefix + WEB_ANSWER_SYSTEM + avoid },
            {
              role: "user",
              content: `【模型槽位】${args.slot || "?"}${attempt > 1 ? ` · 重试${attempt}` : ""}\n\n${userPrompt}`,
            },
          ],
        }),
      });
      clearTimeout(timeoutId);
      if (!r.ok) {
        const t = await r.text();
        lastNote = `web_answer:http_${r.status}`;
        const modelMissing = r.status === 503 && /model_not_found|no available channel/i.test(t);
        console.error("[webTriAnswer]", args.slot, model, r.status, t.slice(0, 300));
        if ((isRetriableHttpStatus(r.status) || modelMissing) && attempt < maxAttempts) {
          await sleepMs(r.status === 504 ? 400 * attempt : 800 * attempt);
          continue;
        }
        return { markdown: null, note: lastNote, plan: null, planNote: null };
      }
      const j = await r.json();
      const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) {
        lastNote = "web_answer:empty";
        continue;
      }
      const fin = finalizeSynthesisMarkdown(text);
      return {
        markdown: fin.markdown,
        note: attempt > 1 ? `web_answer:ok_retry_${attempt}` : "web_answer:ok",
        plan: fin.plan,
        planNote: fin.planNote,
      };
    } catch (e) {
      clearTimeout(timeoutId);
      lastNote = `web_answer_err:${String(e?.message || e).slice(0, 80)}`;
      if (attempt < maxAttempts) {
        await sleepMs(800 * attempt);
        continue;
      }
    }
  }
  return { markdown: null, note: lastNote, plan: null, planNote: null };
}

async function runWebAnswerLiteFallback(args) {
  const liteBase = buildLiteWebAnswerBase(
    args.base,
    args.papers,
    args.userQuery,
    args.coreQuery,
    args.conversationContext,
  );
  const model = resolveWebFallbackModel(args.primaryModel);
  const key = args.apiKey;
  const url = args.chatCompletionsUrl;
  if (!key) return { markdown: null, note: "web_lite:no-key", plan: null, planNote: null };
  console.warn("[webTriAnswer] lite fallback with model", model, "papers", liteBase.usedCount);
  return runSingleWebAnswer({
    ...liteBase,
    apiKey: key,
    model,
    chatCompletionsUrl: url,
    slot: "lite",
    lite: true,
    personaSkill: args.personaSkill,
    outputAvoidanceHint: args.outputAvoidanceHint,
  });
}

async function mergeThreeWebAnswers(args) {
  const userQuery = String(args.userQuery ?? "").trim().slice(0, 6000);
  const coreQuery = String(args.coreQuery ?? userQuery).trim().slice(0, 800);
  const a = String(args.markdownA ?? "").trim().slice(0, 10_000);
  const b = String(args.markdownB ?? "").trim().slice(0, 10_000);
  const c = String(args.markdownC ?? "").trim().slice(0, 10_000);
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = String(args.outputAvoidanceHint ?? "").trim()
    ? `\n\n【输出偏好】\n${String(args.outputAvoidanceHint).slice(0, 2000)}`
    : "";

  const controller = new AbortController();
  const ms = synthesisTimeoutMs();
  const timeoutId = setTimeout(() => controller.abort(), ms);

  try {
    const r = await fetch(args.chatCompletionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: args.model,
        temperature: 0.1,
        max_tokens: Math.min(8000, Math.max(4500, Number(process.env.WEB_MERGE_MAX_TOKENS) || 6000)),
        messages: [
          { role: "system", content: skillPrefix + WEB_MERGE_3_SYSTEM + avoid },
          {
            role: "user",
            content:
              `【核心问题】\n${coreQuery}\n\n` +
              `--- 模型 A 回答 ---\n${a}\n\n` +
              `--- 模型 B 回答 ---\n${b}\n\n` +
              `--- 模型 C 回答 ---\n${c}\n\n` +
              "请输出经比较、去重、**剔除跑题**后的唯一终稿。",
          },
        ],
      }),
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      return { markdown: null, note: `web_merge:http_${r.status}` };
    }
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return { markdown: null, note: "web_merge:empty", plan: null, planNote: null };
    const fin = finalizeSynthesisMarkdown(text);
    return {
      markdown: fin.markdown,
      note: "web_merge:ok",
      plan: fin.plan,
      planNote: fin.planNote,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    return { markdown: null, note: `web_merge_err:${e?.message || "unknown"}` };
  }
}

/**
 * @param {{ userQuery: string; effectiveQuery?: string; papers: object[]; apiKey?: string; model?: string; modelB?: string; chatCompletionsUrl?: string; personaSkill?: string; outputAvoidanceHint?: string }} p
 */
export async function synthesizeWebTriAnswer(p) {
  const key = resolveApiKey(String(p.apiKey ?? "").trim());
  const triCfg = readTriKeys(p.chatCompletionsUrl, p.model, p.modelB);
  if (!triCfg && !key) {
    return {
      markdown: null,
      note: "web_tri:no-llm-key",
      synthesisModels: null,
      webAnswerDrafts: null,
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
      synthesisModels: null,
      webAnswerDrafts: null,
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

  const directCfg = triCfg || (key ? { keyB: key, urlB: resolveChatCompletionsUrl(p.chatCompletionsUrl), modelB: sanitizeModel(p.model) } : null);
  const lowQualityPick = isLowQualityWebPick(papers, userQuery, picked.coreQuery);
  const hasRichAttachment =
    String(p.attachmentContext ?? "").trim().length >= attachmentSynthMinChars();
  if (
    directCfg &&
    webDirectFallbackEnabled() &&
    lowQualityPick &&
    !hasRichAttachment &&
    !isBookIntentQuery(userQuery)
  ) {
    const dr = await runWebDirectKnowledgeAnswer({
      userQuery,
      apiKey: triCfg ? triCfg.keyB : directCfg.keyB,
      model: resolveWebFallbackModel(triCfg ? triCfg.modelB : directCfg.modelB),
      chatCompletionsUrl: triCfg ? triCfg.urlB : directCfg.urlB,
      personaSkill: p.personaSkill,
      outputAvoidanceHint: p.outputAvoidanceHint,
      slot: "direct",
    });
    if (dr.markdown) {
      return {
        markdown: prependDirectDisclaimer(dr.markdown),
        plan: dr.plan ?? null,
        planNote: dr.planNote ?? null,
        note: `web_tri:direct_knowledge:${dr.note}|${sourceNoteEarly}|pick_low_quality`,
        synthesisModels: { mode: "web_tri_direct_knowledge", modelB: triCfg?.modelB },
        webAnswerDrafts: { modelB: dr.markdown, noteB: dr.note },
      };
    }
  }

  if (!papers.length) {
    if (directCfg && webDirectFallbackEnabled()) {
      const dr = await runWebDirectKnowledgeAnswer({
        userQuery,
        apiKey: triCfg ? triCfg.keyB : directCfg.keyB,
        model: resolveWebFallbackModel(triCfg ? triCfg.modelB : directCfg.modelB),
        chatCompletionsUrl: triCfg ? triCfg.urlB : directCfg.urlB,
        personaSkill: p.personaSkill,
        outputAvoidanceHint: p.outputAvoidanceHint,
        slot: "direct",
      });
      if (dr.markdown) {
        return {
          markdown: prependDirectDisclaimer(dr.markdown),
          plan: dr.plan ?? null,
          planNote: dr.planNote ?? null,
          note: `web_tri:direct_knowledge:${dr.note}|${sourceNoteEarly}`,
          synthesisModels: { mode: "web_tri_direct_knowledge", modelB: triCfg?.modelB },
          webAnswerDrafts: { modelB: dr.markdown, noteB: dr.note },
        };
      }
    }
    return {
      markdown: buildNoSourcesMarkdown(picked.coreQuery),
      plan: null,
      planNote: null,
      note: `web_tri:no-relevant-sources|${sourceNoteEarly}`,
      synthesisModels: { mode: "web_tri_no_sources" },
      webAnswerDrafts: null,
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
  };
  const sourceNote = `sources=${papers.length}/${picked.totalIn}|filtered=${picked.filteredOut}`;

  const triMode = webTriMode();
  const singleModel = resolveWebFallbackModel(triCfg?.modelB || p.model);

  if (triMode === "single") {
    const ultraBase = buildLiteWebAnswerBase(
      {
        userQuery,
        coreQuery: picked.coreQuery,
        excerptList: "",
        userPromptBody: "",
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
      true,
    );
    const singleKey = triCfg?.keyB || key;
    const singleUrl = triCfg?.urlB || resolveChatCompletionsUrl(p.chatCompletionsUrl);
    let one = await runSingleWebAnswer({
      ...ultraBase,
      apiKey: singleKey,
      model: singleModel,
      chatCompletionsUrl: singleUrl,
      slot: "single",
      lite: true,
    });
    if (!one.markdown) {
      one = await runSingleWebAnswer({
        ...liteBase,
        apiKey: singleKey,
        model: singleModel,
        chatCompletionsUrl: singleUrl,
        slot: "single-lite",
        lite: true,
      });
    }
    if (!one.markdown) {
      one = await runWebAnswerLiteFallback({
        base: liteBase,
        papers,
        userQuery,
        coreQuery: picked.coreQuery,
        conversationContext: p.conversationContext,
        apiKey: singleKey,
        chatCompletionsUrl: singleUrl,
        primaryModel: singleModel,
        personaSkill: p.personaSkill,
        outputAvoidanceHint: p.outputAvoidanceHint,
      });
    }
    if (one.markdown) {
      return {
        markdown: one.markdown,
        plan: one.plan ?? null,
        planNote: one.planNote ?? null,
        note: `web_tri:single_ok:${one.note}|${sourceNote}`,
        synthesisModels: { mode: "web_tri_single", modelA: singleModel },
        webAnswerDrafts: { modelA: one.markdown, noteA: one.note },
      };
    }
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: `web_tri:single_failed:${one.note}|${sourceNote}`,
      synthesisModels: { mode: "web_tri_single_failed", modelA: singleModel },
      webAnswerDrafts: null,
    };
  }

  const base = fullBase;
  let ra;
  let rb;
  let rc;
  let modelA;
  let modelB;
  let modelC;
  let arbKey;
  let arbUrl;
  let arbModel;

  const concurrency = webTriConcurrency();

  if (triCfg) {
    modelA = triCfg.modelA;
    modelB = triCfg.modelB;
    modelC = triCfg.modelC;
    arbKey = triCfg.keyC;
    arbUrl = triCfg.urlC;
    arbModel = triCfg.modelC;
    [ra, rb, rc] = await runWebAnswerSlots(
      [
        {
          ...base,
          apiKey: triCfg.keyA,
          model: triCfg.modelA,
          chatCompletionsUrl: triCfg.urlA,
          slot: "A",
        },
        {
          ...base,
          apiKey: triCfg.keyB,
          model: triCfg.modelB,
          chatCompletionsUrl: triCfg.urlB,
          slot: "B",
        },
        {
          ...base,
          apiKey: triCfg.keyC,
          model: triCfg.modelC,
          chatCompletionsUrl: triCfg.urlC,
          slot: "C",
        },
      ],
      concurrency,
    );
  } else {
    const triple = resolveTripleModels(p.model, p.modelB);
    modelA = triple.modelA;
    modelB = triple.modelB;
    modelC = triple.modelC;
    const url = resolveChatCompletionsUrl(p.chatCompletionsUrl);
    arbKey = key;
    arbUrl = url;
    arbModel = modelA;
    [ra, rb, rc] = await runWebAnswerSlots(
      [
        { ...base, apiKey: key, model: modelA, chatCompletionsUrl: url, slot: "A" },
        { ...base, apiKey: key, model: modelB, chatCompletionsUrl: url, slot: "B" },
        { ...base, apiKey: key, model: modelC, chatCompletionsUrl: url, slot: "C" },
      ],
      concurrency,
    );
  }

  const drafts = {
    modelA: ra.markdown,
    modelB: rb.markdown,
    modelC: rc.markdown,
    noteA: ra.note,
    noteB: rb.note,
    noteC: rc.note,
  };

  const synthesisModels = {
    modelA,
    modelB,
    modelC,
    mode: triCfg ? "web_tri_3keys" : "web_tri_single_key",
  };

  const okAnswers = [ra, rb, rc].filter((x) => x.markdown);
  if (!okAnswers.length) {
    const liteKey = triCfg?.keyB || key;
    const liteUrl = triCfg?.urlB || resolveChatCompletionsUrl(p.chatCompletionsUrl);
    const lite = await runWebAnswerLiteFallback({
      base,
      papers,
      userQuery,
      coreQuery: picked.coreQuery,
      conversationContext: p.conversationContext,
      apiKey: liteKey,
      chatCompletionsUrl: liteUrl,
      primaryModel: triCfg?.modelB || modelB || p.model,
      personaSkill: p.personaSkill,
      outputAvoidanceHint: p.outputAvoidanceHint,
    });
    if (lite.markdown) {
      return {
        markdown: lite.markdown,
        plan: lite.plan ?? null,
        planNote: lite.planNote ?? null,
        note: `web_tri:lite_fallback_ok:${lite.note}|${ra.note}|${rb.note}|${rc.note}|${sourceNote}`,
        synthesisModels: {
          ...synthesisModels,
          mode: "web_tri_lite_fallback",
          modelB: resolveWebFallbackModel(triCfg?.modelB || modelB),
        },
        webAnswerDrafts: { ...drafts, modelB: lite.markdown, noteB: lite.note },
      };
    }
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: `web_tri:all_failed:${ra.note}|${rb.note}|${rc.note}|${lite.note}|${sourceNote}`,
      synthesisModels,
      webAnswerDrafts: drafts,
    };
  }

  if (okAnswers.length === 1) {
    const one = okAnswers[0];
    return {
      markdown: one.markdown,
      plan: one.plan ?? null,
      planNote: one.planNote ?? null,
      note: `web_tri:single_ok:${ra.note}|${rb.note}|${rc.note}`,
      synthesisModels: { ...synthesisModels, mode: "web_tri_partial_1" },
      webAnswerDrafts: drafts,
    };
  }

  if (okAnswers.length === 2) {
    const merged = await mergeThreeWebAnswers({
      userQuery,
      markdownA: ra.markdown || rb.markdown || "",
      markdownB: rb.markdown || ra.markdown || "",
      markdownC: rc.markdown || ra.markdown || rb.markdown || "",
      apiKey: arbKey,
      model: arbModel,
      chatCompletionsUrl: arbUrl,
      personaSkill: p.personaSkill,
      outputAvoidanceHint: p.outputAvoidanceHint,
    });
    if (merged.markdown) {
      return {
        markdown: merged.markdown,
        plan: merged.plan ?? pickWebPlan(ra, rb, rc),
        planNote: merged.planNote ?? null,
        note: `web_tri:merge_2of3:${merged.note}`,
        synthesisModels: { ...synthesisModels, mode: "web_tri_merge_2of3" },
        webAnswerDrafts: drafts,
      };
    }
    const longest = [ra, rb, rc].sort((x, y) => (y.markdown?.length || 0) - (x.markdown?.length || 0))[0];
    return {
      markdown: longest.markdown,
      plan: longest.plan ?? pickWebPlan(ra, rb, rc),
      planNote: longest.planNote ?? null,
      note: `web_tri:fallback_longest:${merged.note}`,
      synthesisModels: { ...synthesisModels, mode: "web_tri_fallback" },
      webAnswerDrafts: drafts,
    };
  }

  const merged = await mergeThreeWebAnswers({
    userQuery,
    coreQuery: picked.coreQuery,
    markdownA: ra.markdown || "",
    markdownB: rb.markdown || "",
    markdownC: rc.markdown || "",
    apiKey: arbKey,
    model: arbModel,
    chatCompletionsUrl: arbUrl,
    personaSkill: p.personaSkill,
    outputAvoidanceHint: p.outputAvoidanceHint,
  });

  if (merged.markdown) {
    return {
      markdown: merged.markdown,
      plan: merged.plan ?? pickWebPlan(ra, rb, rc),
      planNote: merged.planNote ?? null,
      note: `web_tri:merge_ok:${merged.note}|${sourceNote}`,
      synthesisModels: { ...synthesisModels, mode: "web_tri_arbitration" },
      webAnswerDrafts: drafts,
    };
  }

  const longest = [ra, rb, rc].sort((x, y) => (y.markdown?.length || 0) - (x.markdown?.length || 0))[0];
  return {
    markdown: longest.markdown,
    plan: longest.plan ?? pickWebPlan(ra, rb, rc),
    planNote: longest.planNote ?? null,
    note: `web_tri:merge_failed_use_longest:${merged.note}`,
    synthesisModels: { ...synthesisModels, mode: "web_tri_fallback_longest" },
    webAnswerDrafts: drafts,
  };
}
