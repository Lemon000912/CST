/**
 * 书籍类问题：用多条公开网页摘录拼「定位 + 按章/结构总结」，不臆造未出现的章节。
 */
import {
  resolveApiKey,
  resolveChatCompletionsUrl,
  sanitizeModel,
  defaultModel,
} from "./rewrite.js";
import { extractBookTitles, isBookIntentQuery } from "./bookWebClues.js";
import {
  WEB_JSON_FOOTER,
  WEB_MARKDOWN_DATA_SECTION,
  finalizeSynthesisMarkdown,
} from "./synthesisExtract.js";

const BOOK_CLUE_SYSTEM =
  "你是「书籍公开线索整理」助手。用户询问某本书的内容或章节结构；系统已从**公开网页**抓取多条摘录（出版社页、序言、书评、目录页等），**不是**全书正文。\n\n" +
  "【硬性规则】\n" +
  "1. 用「书名 + 公开网页线索」拼答案：先给出**书籍定位**（原著/作者/方法/主题，仅摘录中有依据的）。\n" +
  "2. 用户要求「按章节总结」时：用 **## 第 N 章 …** 或 **## Part …** 列出**摘录中明确出现的章节标题**及该章主旨；摘录未写清的章，列入「## 摘录未覆盖的章节」并说明需查阅纸书目录。\n" +
  "3. 每条重要结论后标 **〔n〕** 对应摘录编号；禁止编造 ISBN、未出现的章名、未出现的页码。\n" +
  "4. 若多条摘录指向**中译本 ↔ 英文原著**，应说明对应关系（如 Technics 原书目录），并区分「公开目录」与「推断」。\n" +
  "5. 首段直接回答用户问题；不要写「根据检索」套话。\n" +
  "6. 摘录不足以逐章总结时，诚实说明，并给出已能确认的**结构框架**（如 Part1/Part2、十步法等）。" +
  WEB_MARKDOWN_DATA_SECTION +
  WEB_JSON_FOOTER;

/**
 * @param {object[]} papers
 * @param {number} max
 */
function formatBookClueExcerpts(papers, max = 22) {
  const list = (Array.isArray(papers) ? papers : []).slice(0, max);
  const blocks = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const title = String(p.title ?? "（无标题）").trim().slice(0, 200);
    const url = String(p.absUrl ?? "").trim().slice(0, 500);
    const body = String(p.summary ?? p.abstract ?? "").trim().slice(0, 2800);
    blocks.push(`[${i + 1}] ${title}\nURL: ${url || "—"}\n${body || "（无摘要）"}`);
  }
  return blocks.join("\n\n---\n\n");
}

/**
 * @param {{ userQuery: string; papers: object[]; bookTitles?: string[]; conversationContext?: string; apiKey?: string; model?: string; chatCompletionsUrl?: string; personaSkill?: string; outputAvoidanceHint?: string }} p
 */
export async function synthesizeBookFromWebClues(p) {
  const papers = Array.isArray(p.papers) ? p.papers : [];
  const userQuery = String(p.userQuery ?? "").trim();
  if (!userQuery || !isBookIntentQuery(userQuery)) {
    return { markdown: null, plan: null, planNote: null, note: "book_clue:not-book-intent", synthesisModels: null };
  }
  if (papers.length < 1) {
    return { markdown: null, plan: null, planNote: null, note: "book_clue:no-papers", synthesisModels: null };
  }

  const key = resolveApiKey(String(p.apiKey ?? "").trim());
  if (!key) {
    return { markdown: null, plan: null, planNote: null, note: "book_clue:no-llm-key", synthesisModels: null };
  }

  const titles = (p.bookTitles?.length ? p.bookTitles : extractBookTitles(userQuery)).slice(0, 3);
  const titleLabel = titles.join(" / ") || "（未解析书名）";
  const excerpts = formatBookClueExcerpts(papers, 24);
  const convo = String(p.conversationContext ?? "").trim().slice(0, 1500);
  const skillRaw = String(p.personaSkill ?? "").trim().slice(0, 2000);
  const skillPrefix = skillRaw ? `【用户身份/用途】\n${skillRaw}\n\n---\n\n` : "";
  const avoid = String(p.outputAvoidanceHint ?? "").trim()
    ? `\n\n【输出偏好】\n${String(p.outputAvoidanceHint).slice(0, 2000)}`
    : "";

  const userPrompt =
    (convo ? `【对话上文】\n${convo}\n\n` : "") +
    `【用户问题】\n${userQuery.slice(0, 4000)}\n\n` +
    `【目标书籍】${titleLabel}\n\n` +
    `【公开网页摘录】（共 ${papers.length} 条，作答唯一依据；编号 [n] 与下文一致）\n${excerpts}\n\n` +
    "请用简体中文作答：先书籍定位，再按用户要求组织章节/结构总结；不得编造摘录中未出现的章名。";

  const url = resolveChatCompletionsUrl(p.chatCompletionsUrl);
  const model = sanitizeModel(String(p.model ?? "").trim() || defaultModel());
  const controller = new AbortController();
  const ms = Math.min(360_000, Math.max(25_000, Number(process.env.SYNTHESIS_TIMEOUT_MS) || 120_000));
  const timeoutId = setTimeout(() => controller.abort(), ms);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.15,
        max_tokens: Math.min(8000, Math.max(4500, Number(process.env.BOOK_CLUE_SYNTH_MAX_TOKENS) || 6500)),
        messages: [
          { role: "system", content: skillPrefix + BOOK_CLUE_SYSTEM + avoid },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      return { markdown: null, plan: null, planNote: null, note: `book_clue:http_${r.status}`, synthesisModels: null };
    }
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) {
      return { markdown: null, plan: null, planNote: null, note: "book_clue:empty", synthesisModels: null };
    }
    const fin = finalizeSynthesisMarkdown(text);
    return {
      markdown: fin.markdown,
      plan: fin.plan,
      planNote: fin.planNote,
      note: `book_clue:ok|sources=${papers.length}|titles=${titles.length}`,
      synthesisModels: { modelA: model, mode: "book_web_clues" },
    };
  } catch (e) {
    clearTimeout(timeoutId);
    return {
      markdown: null,
      plan: null,
      planNote: null,
      note: `book_clue_err:${String(e?.message || e).slice(0, 80)}`,
      synthesisModels: null,
    };
  }
}

/**
 * @param {string} query
 * @param {object[]} papers
 */
export function shouldUseBookClueSynthesis(query, papers) {
  if (!isBookIntentQuery(query)) return false;
  return Array.isArray(papers) && papers.length >= 1;
}
