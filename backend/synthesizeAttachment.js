/**
 * 上传文件正文优先的综合回答（不依赖联网检索摘录）。
 */
import { resolvePrimaryProvider, resolveTriProviders } from "./llmProviders.js";
import { generateText } from "./llmClient.js";
import { resolveSecondaryModel } from "./synthesize.js";
import {
  WEB_JSON_FOOTER,
  WEB_MARKDOWN_DATA_SECTION,
  finalizeSynthesisMarkdown,
} from "./synthesisExtract.js";

const ATTACHMENT_SYNTH_SYSTEM =
  "你是「上传文档分析」助手。用户已上传文件，系统已从 PDF/Word/PPT 等解析出正文摘录。\n\n" +
  "【硬性规则】\n" +
  "1. **只能**依据【上传文件摘录】作答；禁止用通用常识补充文档未出现的公司名、产能、产品型号、应用场景。\n" +
  "2. 用户问行业、应用场景、技术路线时：须**逐条列出文档中写明的方向**；文档未写明的要点列入「未在文档中出现：…」。\n" +
  "3. 幻灯片/排版导致文字顺序错乱时，根据可辨认的标题、编号（如 01. 02.）、关键词归纳，勿因排版乱而编造。\n" +
  "4. 版式：首段 2～4 句直接回答 → **## 二级标题** 分板块 → 列表写清「应用方向 + 具体场景」；关键事实后可标 **〔文档〕**。\n" +
  "5. 禁止「根据检索」「综上所述」等套话；不要声称使用了网页搜索。\n" +
  "6. 若摘录不足以回答，明确说明「上传文档摘录中未涉及…」，不要猜测。" +
  WEB_MARKDOWN_DATA_SECTION +
  WEB_JSON_FOOTER;

const ATTACHMENT_MERGE_SYSTEM =
  "你是仲裁编辑。合并模型 A/B 两份「仅依据上传文档摘录」的回答为**唯一终稿**。\n\n" +
  "规则：\n" +
  "- 只保留两份中均有摘录依据、且与【用户问题】一致的论述；删除无依据或互相矛盾的发挥。\n" +
  "- 保留文档中列出的应用编号、产品名、行业名；不得新增文档未出现的场景。\n" +
  "- 结构清晰：首段结论 → ## 分板块 → 列表；须保留 **## 关键数据与指标**（合并去重）。" +
  WEB_JSON_FOOTER;

/** @returns {number} */
export function attachmentSynthMinChars() {
  const n = Number(process.env.ATTACHMENT_SYNTH_MIN_CHARS);
  if (Number.isFinite(n) && n > 0) return Math.min(20_000, Math.max(80, Math.floor(n)));
  return 400;
}

/**
 * 是否应走「上传正文优先」合成（跳过联网/文献摘录作主依据）。
 * @param {string} attachmentContext
 * @param {string} [userQuery]
 */
export function shouldUseAttachmentPrimarySynthesis(attachmentContext, userQuery = "") {
  const att = String(attachmentContext ?? "").trim();
  if (!att.length) return false;
  const q = String(userQuery ?? "").trim();
  const min = attachmentSynthMinChars();
  const explicitDocQuery =
    /仅.{0,6}上传|上传.{0,8}(文档|文件)|根据.{0,12}(文档|文件|附件|材料)|附件内容|这份\s*(pdf|ppt|材料)/i.test(
      q,
    );
  /** 用户明确要依据上传作答时，略降字数门槛（仍须有一定摘录，避免空附件 hallucination） */
  const explicitMin = Math.min(80, min);
  if (explicitDocQuery && att.length >= explicitMin) return true;
  if (att.length < min) return false;
  if (explicitDocQuery) return true;
  if (att.length >= 1500) return true;
  if (att.length >= min && q.length > 0) return true;
  return false;
}

function readTriKeys(clientUrl, clientModelA, modelBHint) {
  return resolveTriProviders({
    chatCompletionsUrl: clientUrl,
    model: clientModelA,
    modelB: modelBHint,
  });
}

function buildAttachmentUserPrompt(args) {
  const q = String(args.userQuery ?? "").trim().slice(0, 6000);
  const convo = String(args.conversationContext ?? "").trim().slice(0, 2000);
  const excerpt = String(args.attachmentContext ?? "").trim().slice(0, 100_000);
  const name = String(args.filename ?? "上传文件").trim().slice(0, 200);
  return (
    (convo ? `【对话上文（仅供指代消解）】\n${convo}\n\n` : "") +
    `【用户问题】\n${q || "请概括上传文档要点并回答其中涉及的应用场景。"}\n\n` +
    `【上传文件】${name}\n` +
    `【上传文件摘录】（${excerpt.length.toLocaleString()} 字，作答唯一依据）\n${excerpt}\n\n` +
    "请基于以上摘录作答（简体中文）。"
  );
}

/**
 * @param {{ userQuery: string; attachmentContext: string; filename?: string; conversationContext?: string; apiKey: string; model: string; chatCompletionsUrl: string; personaSkill?: string; outputAvoidanceHint?: string; slot?: string }} args
 */
async function runAttachmentDraft(args) {
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = String(args.outputAvoidanceHint ?? "").trim()
    ? `\n\n【输出偏好】\n${String(args.outputAvoidanceHint).slice(0, 2000)}`
    : "";
  const userPrompt = buildAttachmentUserPrompt(args);
  const ms = Math.min(360_000, Math.max(25_000, Number(process.env.SYNTHESIS_TIMEOUT_MS) || 120_000));

  try {
    const result = await generateText(args.provider, {
      timeoutMs: ms,
      temperature: 0.12,
      maxTokens: Math.min(8000, Math.max(4000, Number(process.env.ATTACHMENT_SYNTH_MAX_TOKENS) || 6500)),
      system: skillPrefix + ATTACHMENT_SYNTH_SYSTEM + avoid,
      messages: [{ role: "user", content: `【模型槽位】${args.slot || "?"}\n\n${userPrompt}` }],
    });
    if (!result.ok) {
      console.error("[attachmentSynth]", args.slot, args.provider?.model, result.status, result.error);
      return { markdown: null, note: `attach:${result.error}` };
    }
    const text = result.text;
    if (!text) return { markdown: null, note: "attach:empty" };
    const fin = finalizeSynthesisMarkdown(text);
    return { markdown: fin.markdown, note: "attach:ok", plan: fin.plan, planNote: fin.planNote };
  } catch (e) {
    return { markdown: null, note: `attach_err:${String(e?.message || e).slice(0, 80)}` };
  }
}

async function mergeAttachmentDrafts(args) {
  const skillRaw = String(args.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = String(args.outputAvoidanceHint ?? "").trim()
    ? `\n\n【输出偏好】\n${String(args.outputAvoidanceHint).slice(0, 2000)}`
    : "";
  const ms = Math.min(360_000, Math.max(25_000, Number(process.env.SYNTHESIS_TIMEOUT_MS) || 120_000));

  try {
    const result = await generateText(args.provider, {
      timeoutMs: ms,
      temperature: 0.1,
      maxTokens: Math.min(8000, Math.max(4500, Number(process.env.ATTACHMENT_SYNTH_MAX_TOKENS) || 6500)),
      system: skillPrefix + ATTACHMENT_MERGE_SYSTEM + avoid,
      messages: [
        {
          role: "user",
          content:
            `【用户问题】\n${String(args.userQuery ?? "").slice(0, 2000)}\n\n` +
            `--- 模型 A ---\n${String(args.markdownA ?? "").slice(0, 12_000)}\n\n` +
            `--- 模型 B ---\n${String(args.markdownB ?? "").slice(0, 12_000)}\n\n` +
            "请输出合并后的唯一终稿。",
        },
      ],
    });
    if (!result.ok) return { markdown: null, note: `attach_merge:${result.error}` };
    const text = result.text;
    if (!text) return { markdown: null, note: "attach_merge:empty" };
    const fin = finalizeSynthesisMarkdown(text);
    return { markdown: fin.markdown, note: "attach_merge:ok", plan: fin.plan, planNote: fin.planNote };
  } catch (e) {
    return { markdown: null, note: `attach_merge_err:${e?.message || "unknown"}` };
  }
}

/**
 * @param {{ userQuery: string; attachmentContext: string; filename?: string; conversationContext?: string; apiKey?: string; model?: string; modelB?: string; chatCompletionsUrl?: string; personaSkill?: string; outputAvoidanceHint?: string }} p
 */
export async function synthesizeFromAttachmentContext(p) {
  const attachmentContext = String(p.attachmentContext ?? "").trim();
  if (!attachmentContext) {
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: "attach_synth:no-context",
      synthesisModels: null,
    };
  }

  const primary = resolvePrimaryProvider(p);
  const triCfg = readTriKeys(p.chatCompletionsUrl, p.model, p.modelB);
  if (!triCfg && !primary) {
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: "attach_synth:no-llm-key",
      synthesisModels: null,
    };
  }

  const base = {
    userQuery: p.userQuery,
    attachmentContext,
    filename: p.filename,
    conversationContext: p.conversationContext,
    personaSkill: p.personaSkill,
    outputAvoidanceHint: p.outputAvoidanceHint,
  };
  const chars = attachmentContext.length;

  if (triCfg) {
    const [ra, rb] = await Promise.all([
      runAttachmentDraft({ ...base, provider: triCfg.A, slot: "A" }),
      runAttachmentDraft({ ...base, provider: triCfg.B, slot: "B" }),
    ]);
    const synthesisModels = {
      modelA: triCfg.A.model,
      modelB: triCfg.B.model,
      modelC: triCfg.C.model,
      mode: "attachment_tri",
    };

    if (ra.markdown && rb.markdown) {
      const merged = await mergeAttachmentDrafts({
        userQuery: p.userQuery,
        markdownA: ra.markdown,
        markdownB: rb.markdown,
        provider: triCfg.C,
        personaSkill: p.personaSkill,
        outputAvoidanceHint: p.outputAvoidanceHint,
      });
      if (merged.markdown) {
        return {
          markdown: merged.markdown,
          plan: merged.plan ?? ra.plan ?? rb.plan ?? null,
          planNote: merged.planNote ?? null,
          note: `attach_synth:tri_merge_ok|chars=${chars}`,
          synthesisModels: { ...synthesisModels, mode: "attachment_tri_merge" },
        };
      }
    }

    const pick = ra.markdown ? ra : rb;
    if (pick.markdown) {
      return {
        markdown: pick.markdown,
        plan: pick.plan ?? null,
        planNote: pick.planNote ?? null,
        note: `attach_synth:tri_single_ok|chars=${chars}`,
        synthesisModels: { ...synthesisModels, mode: "attachment_tri_single" },
      };
    }
  }

  const singleProvider = primary || triCfg?.A;
  const r = await runAttachmentDraft({
    ...base,
    provider: singleProvider,
    slot: "single",
  });
  if (r.markdown) {
    return {
      markdown: r.markdown,
      plan: r.plan ?? null,
      planNote: r.planNote ?? null,
      note: `attach_synth:single_ok|chars=${chars}`,
      synthesisModels: { modelA: singleProvider.model, mode: "attachment_single" },
    };
  }

  return {
    markdown: null,
    plan: null,
    planNote: null,
    note: `attach_synth:fail:${r.note}`,
    synthesisModels: null,
  };
}
