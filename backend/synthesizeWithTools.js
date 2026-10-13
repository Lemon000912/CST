/**
 * 带工具调用的综合服务
 * 模型可以主动决定是否需要联网搜索
 */

import { resolvePrimaryProvider } from "./llmProviders.js";
import { generateTextWithTools, providerSupportsTools } from "./llmClientWithTools.js";
import { generateText } from "./llmClient.js";

/**
 * 智能综合：模型自主决定是否需要联网搜索
 * @param {object} options
 * @param {string} options.query - 用户查询
 * @param {object[]} options.papers - 已有的文献/网页结果
 * @param {string} [options.model] - 指定模型
 * @param {boolean} [options.forceWebSearch=false] - 强制启用联网搜索工具
 * @returns {Promise<object>} { text, usage, toolCalls, provider }
 */
export async function synthesizeWithAutoTools(options) {
  const query = String(options?.query || "").trim();
  const papers = Array.isArray(options?.papers) ? options.papers : [];
  const forceWebSearch = options?.forceWebSearch ?? false;

  // 解析Provider
  const provider = resolvePrimaryProvider(options?.model);
  if (!provider?.apiKey) {
    throw new Error("LLM Provider未配置");
  }

  console.log(`[synthesize.auto_tools] query="${query.slice(0, 100)}" papers=${papers.length}`);

  // 检查Provider是否支持工具调用
  const supportsTools = providerSupportsTools(provider);
  console.log(`[synthesize.auto_tools] Provider supports tools: ${supportsTools}`);

  // 决定是否启用联网搜索工具
  const enableWebSearch = forceWebSearch || (supportsTools && shouldEnableWebSearchTool(query, papers));
  console.log(`[synthesize.auto_tools] Enable web search tool: ${enableWebSearch}`);

  // 构建System Prompt
  const systemPrompt = buildSystemPromptWithTool(enableWebSearch);

  // 构建上下文
  const context = buildContext(query, papers);

  // 构建消息
  const messages = [
    {
      role: "user",
      content: context,
    },
  ];

  // 调用LLM（带工具支持）
  if (enableWebSearch && supportsTools) {
    const result = await generateTextWithTools(provider, {
      system: systemPrompt,
      messages,
      temperature: 0.3,
      maxTokens: 4000,
      enableWebSearch: true,
      maxToolIterations: 3,
      timeoutMs: 180_000, // 3分钟超时
    });

    console.log(`[synthesize.auto_tools] Generated ${result.text.length} chars with ${result.toolCalls.length} tool calls`);

    return {
      text: result.text,
      usage: result.usage,
      toolCalls: result.toolCalls,
      provider: provider.model,
    };
  } else {
    // 降级到普通综合（无工具）
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
}

/**
 * 判断是否应该启用联网搜索工具
 * 规则：
 * 1. 查询包含时间（如2026、2025等）
 * 2. 查询包含实时性关键词（如"最新"、"当前"、"现在"）
 * 3. 查询包含指标关键词（如"产能利用率"、"价格"、"开工率"）
 * 4. 现有结果较少（<5条）
 */
function shouldEnableWebSearchTool(query, papers) {
  const q = query.toLowerCase();

  // 规则1：包含年份
  const hasYear = /20\d{2}/.test(query);

  // 规则2：实时性关键词
  const hasRealtime = /最新|当前|现在|目前|今年|本月|近期|实时/.test(query);

  // 规则3：数据指标关键词
  const hasMetric = /产能利用率|开工率|价格|销量|市场份额|增长率|统计|数据|指标/.test(query);

  // 规则4：结果较少
  const hasLittleData = papers.length < 5;

  // 满足任意2个条件就启用
  const score = [hasYear, hasRealtime, hasMetric, hasLittleData].filter(Boolean).length;

  console.log(`[synthesize.auto_tools] Decision factors: year=${hasYear} realtime=${hasRealtime} metric=${hasMetric} littleData=${hasLittleData} score=${score}/4`);

  return score >= 2;
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
- 可以多次调用工具搜索不同的关键词
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
    context += `请使用联网搜索工具查找相关信息。\n\n`;
  }

  context += `请回答用户问题。如果信息不足，使用 web_search 工具搜索更多信息。`;

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
