/**
 * 数据库渠道：文献综述 + 全网检索回答并行生成后合并为单一输出。
 */
import { synthesizeFromPapers } from "./synthesize.js";
import { synthesizeWebTriAnswer } from "./webTriAnswer.js";

const WEB_SOURCES = new Set([
  "mcp_web",
  "ddg_web",
  "dataify_web",
  "tavily_web",
  "searx_web",
  "qwant_web",
  "mojeek_web",
  "entity_seed",
]);

function isWebPaper(p) {
  return WEB_SOURCES.has(String(p?.source ?? ""));
}

function mergePlans(litPlan, webPlan) {
  if (!litPlan && !webPlan) return null;
  if (!webPlan) return litPlan ?? null;
  if (!litPlan) return webPlan ?? null;
  const litData = Array.isArray(litPlan.extractedData) ? litPlan.extractedData : [];
  const webData = Array.isArray(webPlan.extractedData) ? webPlan.extractedData : [];
  const steps = Array.isArray(litPlan.steps) && litPlan.steps.length ? litPlan.steps : webPlan.steps;
  return {
    ...litPlan,
    ...webPlan,
    steps: steps ?? litPlan.steps ?? webPlan.steps,
    extractedData: [...litData, ...webData].slice(0, 40),
  };
}

/**
 * @param {Parameters<typeof synthesizeFromPapers>[0] & { effectiveQuery?: string; conversationContext?: string; attachmentContext?: string }} p
 */
export async function synthesizeDatabaseCombined(p) {
  const papers = Array.isArray(p.papers) ? p.papers : [];
  const hasWeb = papers.some(isWebPaper);

  // Hybrid mode has two concurrent writers. Keep it atomic so their deltas cannot interleave.
  const litPromise = synthesizeFromPapers({
    ...p,
    onTextDelta: hasWeb ? undefined : p.onTextDelta,
  });
  const webPromise = hasWeb
    ? synthesizeWebTriAnswer({
        userQuery: p.userQuery,
        conversationContext: p.conversationContext,
        attachmentContext: p.attachmentContext,
        effectiveQuery: p.effectiveQuery,
        papers,
        apiKey: p.apiKey,
        model: p.model,
        modelB: p.modelB,
        chatCompletionsUrl: p.chatCompletionsUrl,
        personaSkill: p.personaSkill,
        outputAvoidanceHint: p.outputAvoidanceHint,
        performanceTrace: p.performanceTrace,
      })
    : Promise.resolve({
        markdown: null,
        note: "db_hybrid:web_skipped",
        plan: null,
        planNote: null,
        synthesisModels: null,
        webAnswerDrafts: null,
      });

  const [lit, web] = await Promise.all([litPromise, webPromise]);

  if (lit.markdown && web.markdown) {
    const markdown =
      `${lit.markdown.trim()}\n\n---\n\n## 网络检索综合\n\n${web.markdown.trim()}`;
    return {
      markdown,
      plan: mergePlans(lit.plan, web.plan),
      planNote: [lit.planNote, web.planNote].filter(Boolean).join(" · ") || null,
      note: `db_hybrid:lit+web|${lit.note}|${web.note}`,
      synthesisModels: {
        mode: "database_hybrid",
        literature: lit.synthesisModels ?? { mode: "literature" },
        web: web.synthesisModels ?? { mode: "web_tri" },
      },
      webAnswerDrafts: web.webAnswerDrafts ?? null,
    };
  }

  if (lit.markdown) {
    return {
      markdown: lit.markdown,
      plan: lit.plan ?? null,
      planNote: lit.planNote ?? null,
      note: hasWeb ? `db_hybrid:lit_only|${lit.note}|${web.note}` : lit.note,
      synthesisModels: lit.synthesisModels ?? { mode: "literature" },
      webAnswerDrafts: null,
    };
  }

  if (web.markdown) {
    return {
      markdown: web.markdown,
      plan: web.plan ?? null,
      planNote: web.planNote ?? null,
      note: `db_hybrid:web_only|${web.note}`,
      synthesisModels: web.synthesisModels ?? { mode: "web_tri" },
      webAnswerDrafts: web.webAnswerDrafts ?? null,
    };
  }

  return {
    markdown: null,
    plan: null,
    planNote: null,
    note: `db_hybrid:empty|${lit.note}|${web.note}`,
    synthesisModels: null,
    webAnswerDrafts: null,
  };
}
