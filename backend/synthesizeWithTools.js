/**
 * 兼容旧「智能综合」入口。
 * 当前只使用调用方提供的检索结果，不启用模型工具调用。
 */

import { resolvePrimaryProvider } from "./llmProviders.js";
import { generateText } from "./llmClient.js";

/**
 * 智能综合：使用调用方已经完成的检索结果，不再让模型二次调用联网工具。
 *
 * 这个函数和 /api/v1/search/smart 保留是为了兼容旧客户端；项目当前的联网
 * 搜索统一由 runPaperSearch 在请求开始后完成，然后把结果作为上下文交给模型。
 * @param {object} options
 * @param {string} options.query - 用户查询
 * @param {object[]} options.papers - 已有的文献/网页结果
 * @param {string} [options.model] - 指定模型
 * @param {boolean} [options.forceWebSearch=false] - 兼容旧参数，当前忽略
 * @returns {Promise<object>} { text, usage, toolCalls: [], provider }
 */
export async function synthesizeWithAutoTools(options) {
  const query = String(options?.query || "").trim();
  const papers = Array.isArray(options?.papers) ? options.papers : [];

  // 解析Provider
  const provider = resolvePrimaryProvider(options?.model);
  if (!provider?.apiKey) {
    throw new Error("LLM Provider未配置");
  }

  console.log(`[synthesize.auto_tools] query="${query.slice(0, 100)}" papers=${papers.length}`);

  // 联网搜索已经在 runPaperSearch 中完成。这里明确不再提供 web_search
  // Function Calling，避免同一次用户请求重复搜索或绕过项目的多源合并逻辑。
  console.log("[synthesize.auto_tools] web_search tool disabled; using retrieved context only");

  const systemPrompt = buildSystemPromptWithTool(false);

  // 构建上下文
  const context = buildContext(query, papers);

  // 构建消息
  const messages = [
    {
      role: "user",
      content: context,
    },
  ];

  const result = await generateText(provider, {
    system: systemPrompt,
    messages,
    temperature: 0.3,
    maxTokens: 4000,
    timeoutMs: 120_000,
  });

  return {
    text: result?.text || "",
    usage: result?.usage,
    toolCalls: [],
    provider: provider.model,
  };
}

/**
 * 构建System Prompt（带工具说明）
 */
function buildSystemPromptWithTool(includeToolHint) {
  let prompt = `你是一个专业的信息综合助手。你的任务是基于已有信息回答用户问题。

要求：
- 回答必须准确、全面、有依据
- 引用信息来源时使用 [n] 标注
- 如果已有信息不足，明确说明
- 使用简体中文，语言专业清晰`;

  if (includeToolHint) {
    prompt += `\n\n**重要**：如果已有信息不足以回答问题，你可以使用 web_search 工具进行联网搜索获取更多信息。
- 当需要最新数据、统计指标、行业报告等信息时，主动调用工具
- 搜索查询要具体明确，包含实体名称、指标类型和时间范围
- 对多实体数值问题逐项核对实体、指标、时间和数值；不能只因已有网页条数充足就认为证据完整，缺失的产品应单独补搜
- 对多产品问题按产品分别搜索；优先使用“产能利用率/开工率/开工负荷/装置负荷 + 年份 + 隆众资讯/卓创资讯/我的钢铁网”等定向词
- 如果搜索结果里有可能包含数字的 URL 但摘要不足，调用 web_open_url 读取该 URL 的正文或 PDF；读取失败的 URL 不能当作事实依据
- 已有摘录已直接支持目标实体和指标时不要重复发起宽泛搜索；只补查缺失项，并针对高价值页面打开正文
- 基于搜索结果给出完整答案`;
  }

  return prompt;
}

/**
 * 构建上下文
 */
function buildContext(query, papers) {
  let context = `用户问题：${query}\n\n`;

  if (papers.length > 0) {
    context += `已有信息（${papers.length}条）：\n\n`;

    papers.slice(0, 20).forEach((paper, idx) => {
      const title = String(paper.title || "").slice(0, 200);
      const summary = String(paper.summary || paper.abstract || "").slice(0, 400);
      const url = String(paper.absUrl || paper.url || "");
      const source = String(paper.source || "");

      context += `[${idx + 1}] ${title}\n`;
      if (url) context += `来源: ${url}\n`;
      if (summary) context += `摘要: ${summary}\n`;
      context += `\n`;
    });
  } else {
    context += `已有信息：无\n\n`;
    context += `本轮没有返回可用检索摘录，请明确说明信息不足，不要自行编造事实。\n\n`;
  }

  context += `请基于以上检索摘录回答用户问题；如果信息不足，请明确列出未找到的要点。`;

  return context;
}

/**
 * 格式化工具调用记录（用于日志/展示）
 */
export function formatToolCallsLog(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) {
    return "未使用工具";
  }

  let log = `共调用工具 ${toolCalls.length} 次：\n`;
  toolCalls.forEach((call, idx) => {
    const args = typeof call.arguments === "string"
      ? JSON.parse(call.arguments)
      : call.arguments;
    log += `  ${idx + 1}. [轮次${call.iteration}] ${call.function}(query="${args.query}")\n`;
  });

  return log;
}
