/**
 * 规格 2.1：意图解析与重写。
 * 主任务使用原子 OpenAI-compatible provider：调用方只有同时提供 Key 时 URL/model 覆盖才生效，
 * 否则完整使用服务端 LLM_API_KEY + LLM_CHAT_COMPLETIONS_URL + LLM_MODEL 配置。
 * @param {string} userQuery
 * @param {{ apiKey?: string; model?: string; chatCompletionsUrl?: string }} [opts]
 */

import { extractCoreSearchQuery } from "./searchQueryNormalize.js";
import { generateText } from "./llmClient.js";
import {
  defaultModel,
  openAiChatCompletionsUrl,
  resolvePrimaryProvider,
  safeHttpUrl,
  sanitizeModel,
} from "./llmProviders.js";

export { defaultModel, safeHttpUrl, sanitizeModel } from "./llmProviders.js";

export function resolveChatCompletionsUrl(fromClient) {
  const provider = resolvePrimaryProvider({ chatCompletionsUrl: fromClient });
  return provider ? openAiChatCompletionsUrl(provider) : "";
}

export function resolveApiKey(fromClient) {
  return resolvePrimaryProvider({ apiKey: fromClient })?.apiKey || "";
}

export function resolveRewriteApiKey(fromClient) {
  return resolveApiKey(fromClient);
}

/** 判为「解释用户意图」的废话行，不作为检索式 */
function isVerboseExplanationChunk(t) {
  const s = String(t ?? "").trim();
  if (!s) return true;
  if (s.length > 260) return true;
  const head = s.slice(0, 100).toLowerCase();
  if (
    /^(we need|the user |understand |this is a |this is an |the query |the research |the question |here is |here are |i will |let me |first,|note:|output:)/i.test(
      head,
    )
  )
    return true;
  // 过滤中文胡说八道（当LLM收到乱码输入时的无意义回复）
  if (/^[\u4e00-\u9fff]{2,}.*(?:输入|输出|认为|所以|因为|但是|然而|因此|鉴于|由于)/.test(s.slice(0, 80)))
    return true;
  if (/\bwhich means\b/i.test(s.slice(0, 160))) return true;
  if (/\bthe user (asks|wants|likely)\b/i.test(head)) return true;
  return false;
}

/**
 * 从 LLM 原文中抽出单行英文检索词：忽略开头的意图分析段落，优先短行/句末关键词行。
 * 特别处理包含思考过程的情况（如DeepSeek的reasoning_content）
 */
function normalizeKeywordLine(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";

  // 移除代码块标记
  s = s.replace(/^```[a-zA-Z]*\s*/m, "").replace(/\s*```$/m, "").trim();

  // 移除首尾的引号（包括中文引号）
  s = s.replace(/^[\"'\"'\"'\"'\"'\"']+/, "").replace(/[\"'\"'\"'\"'\"'\"']+$/, "").trim();

  // 如果包含明显的思考过程标记，尝试提取最后的实际输出
  const thinkPatterns = [
    /(?:so|therefore|thus|output|answer|result)[:：]\s*([\s\S]*?)$/i,
    /(?:输出|答案|结果)[:：]\s*([\s\S]*?)$/i,
    /(?:最终|final)\s*(?:输出|output|结果|result)[:：]\s*([\s\S]*?)$/i,
  ];

  for (const pattern of thinkPatterns) {
    const match = s.match(pattern);
    if (match && match[1]) {
      const extracted = match[1].trim().split(/\n/)[0].trim().replace(/^[\"'\"'\"'\"'\"'\"']+/, "").replace(/[\"'\"'\"'\"'\"'\"']+$/, "").trim();
      if (extracted.length >= 5 && extracted.length <= 500 && !isVerboseExplanationChunk(extracted)) {
        return extracted.slice(0, 900);
      }
    }
  }

  // 尝试找到最后一行看起来像关键词的行
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  // 从后往前找，优先找短行且不像说明文的
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^[\"'\"'\"'\"'\"'\"']+/, "").replace(/[\"'\"'\"'\"'\"'\"']+$/, "").trim();
    if (line.length >= 5 && line.length <= 240 && !isVerboseExplanationChunk(line)) {
      return line.slice(0, 900);
    }
  }

  // 如果都失败了，找包含英文关键词的行
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^[\"'\"'\"'\"'\"'\"']+/, "").replace(/[\"'\"'\"'\"'\"'\"']+$/, "").trim();
    if (/[a-zA-Z]{3,}/.test(line) && line.length >= 10 && line.length <= 300) {
      if (!isVerboseExplanationChunk(line)) {
        return line.slice(0, 900);
      }
    }
  }

  return "";
}

/** LLM 401/失败时：从中文问题抽取常见材料/纺织英文检索词（不依赖外部 API） */
export function chineseTechnicalFallback(q) {
  const s = String(q ?? "");
  if (!/[\u4e00-\u9fff]/.test(s)) return "";
  const rules = [
    [/阻燃/, "flame retardant"],
    [/聚酯/, "polyester"],
    [/细旦|细纤|超细/, "fine denier microfiber"],
    [/纤维/, "fiber"],
    [/毛丝|起毛|毛羽|纠缠丝|缠丝|毛圈/, "fuzz hairiness pilling"],
    [/面料|织物|布料/, "fabric textile"],
    [/涤纶|锦纶|氨纶/, "polyester nylon spandex"],
    [/纺丝|纺纱|织造/, "spinning weaving"],
    [/改性|整理/, "finishing modification"],
    [/聚氨酯|SPU/i, "polyurethane SPU"],
    [/\bSPU[-_]?\d+/i, "SPU polyurethane waterproof coating"],
    [/高强/, "high strength"],
    [/桥隧|重载|特种工程/, "bridge tunnel heavy duty engineering"],
    [/拉伸|延伸/, "tensile elongation"],
    [/耐水|耐腐/, "water resistance corrosion resistance"],
    [/环保|添加剂/, "eco-friendly additive formulation"],
    [/工艺优化/, "process optimization"],
  ];
  const parts = [];
  for (const [re, en] of rules) {
    if (re.test(s)) parts.push(en);
  }
  const uniq = [...new Set(parts.join(" ").split(/\s+/).filter(Boolean))];
  return uniq.slice(0, 12).join(" ");
}

/** LLM 未产出时，从原文抽取化学式/英文缩写等，略好于整段中文丢进 ti: */
function asciiKeywordFallback(q) {
  const m = String(q).match(/[A-Za-z][A-Za-z0-9+\-]{1,31}/g);
  if (!m?.length) return "";
  const seen = new Set();
  const out = [];
  for (const w of m) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.join(" ").length > 220) break;
  }
  return out.join(" ").trim();
}

export async function rewriteQueryForSearch(userQuery, opts = {}) {
  const qRaw = String(userQuery ?? "").trim();
  const qCore = extractCoreSearchQuery(qRaw) || qRaw;
  const q = qCore.length >= 4 && qCore.length <= qRaw.length ? qCore : qRaw;
  const convo = String(opts.conversationContext ?? "").trim().slice(0, 3500);
  const fromClient = String(opts.apiKey ?? "").trim();
  const provider = resolvePrimaryProvider({
    apiKey: fromClient,
    model: opts.model,
    chatCompletionsUrl: opts.chatCompletionsUrl,
  });
  if (!provider) {
    return { effectiveQuery: q, note: "stub:no-llm-key" };
  }

  /** 无独立上文、且用户整段粘贴「结合上文…」：规则抽取，避免慢 LLM */
  const skipLlmRewrite =
    !convo &&
    qRaw.length > 48 &&
    /结合|上文|以及|的回答|接着|延续|参考/.test(qRaw) &&
    q.length < qRaw.length * 0.92;
  if (skipLlmRewrite && !opts.forceRewrite) {
    const zhFb = chineseTechnicalFallback(q);
    const ascFb = asciiKeywordFallback(q);
    const fb = zhFb || ascFb || q;
    console.log("[rewrite] Fast mode: conversational core extract");
    return { effectiveQuery: fb, note: "rewrite:conversational-core-skip-llm" };
  }

  // 快速模式：如果查询已经是英文关键词形式，跳过LLM改写
  const isEnglishKeywords = /^[a-zA-Z0-9\s\-_+,.:;()]{10,200}$/.test(q) && 
                            !/[\u4e00-\u9fa5]/.test(q);
  if (isEnglishKeywords && !opts.forceRewrite) {
    console.log('[rewrite] Fast mode: using original English query');
    return { effectiveQuery: q, note: "fast:english-keywords" };
  }
  
  const model = provider.model;
  const skillRaw = String(opts.personaSkill ?? "").trim();
  const skillBlock = skillRaw
    ? `The user has selected a **role / purpose skill** (may be in Chinese). Read it first; it guides domain focus and disambiguation when you output English search keywords.\n\n---\n\n${skillRaw.slice(0, 2800)}\n\n---\n\n`
    : "";
  const systemTail =
    "Translate the user's query to concise English search keywords for academic databases (arXiv/Crossref/OpenAlex). " +
    "If Chinese, translate core technical terms precisely. Correct likely typos first (e.g. 聚脂→聚酯, 聚氨脂→聚氨酯). " +
    (convo
      ? "If conversation history is provided, resolve pronouns and references (e.g. 上文/这个/那/还有) using it, and merge the ongoing topic with the current question into ONE line of keywords. "
      : "") +
    "Output ONLY one line of keywords, no explanation, no preamble.";
  
  const rewriteTimeoutMs = Math.min(
    30_000,
    Math.max(4000, Number(process.env.REWRITE_TIMEOUT_MS) || 12_000),
  );

  try {
    const result = await generateText(provider, {
      timeoutMs: rewriteTimeoutMs,
      temperature: 0.2,
      maxTokens: 128,
      system: skillBlock + systemTail,
      messages: [
        { role: "user", content: convo ? `【对话上文】\n${convo}\n\n【本轮提问】\n${q}` : q },
      ],
    });

    if (!result.ok) {
      console.error("[rewrite] LLM", provider.slot, model, result.status, result.error, result.errorBody);
      const zhFb = chineseTechnicalFallback(q);
      const ascFb = asciiKeywordFallback(q);
      const fb = zhFb || ascFb;
      if (fb) {
        return {
          effectiveQuery: fb,
          note: `rewrite:${result.error}:keyword-fallback`,
        };
      }
      return { effectiveQuery: q, note: `rewrite:${result.error}` };
    }

    let text = normalizeKeywordLine(result.text);
    if (!text && result.reasoningText) text = normalizeKeywordLine(result.reasoningText);
    if (!text && result.text && result.reasoningText) {
      text = normalizeKeywordLine(result.text + "\n" + result.reasoningText);
    }
    
    if (text && isVerboseExplanationChunk(text)) text = "";
    if (!text) {
      const fb = asciiKeywordFallback(q);
      if (fb) {
        return {
          effectiveQuery: fb,
          note: fromClient ? "rewrite:fallback-ascii:user-key" : "rewrite:fallback-ascii",
        };
      }
      console.warn("[rewrite] empty content", {
        finish: result.finishReason,
        model: result.responseModel,
      });
      // 中文查询没有英文关键词时，使用原始查询（让API自行处理）
      return { effectiveQuery: q, note: "rewrite:empty:original" };
    }
    return {
      effectiveQuery: text,
      note: fromClient ? "llm:user-key" : "llm:ok",
    };
  } catch (e) {
    console.error("[rewrite] error", e);
    return { effectiveQuery: q, note: `rewrite_error:${e?.message || "unknown"}` };
  }
}
