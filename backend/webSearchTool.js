/**
 * 联网搜索工具 - 供模型主动调用
 * 模型可以通过Function Calling机制调用此工具进行联网搜索
 */

import { searchBraveWeb } from "./braveWebSearch.js";
import { searchMcpWeb } from "./mcpWebSearch.js";
import { searchDataifyWeb } from "./dataifyWebSearch.js";
import { searchTavilyWeb } from "./tavilyWebSearch.js";

/**
 * 定义联网搜索工具的schema（用于Function Calling）
 */
export const WEB_SEARCH_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "web_search",
    description: "在互联网上搜索实时信息。当需要查询最新数据、统计指标、行业报告、新闻动态等互联网上的信息时使用此工具。适用场景：产能利用率、价格数据、行业统计、公司信息、技术规范等。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询词。应该是具体、明确的查询，包含关键实体名称、指标类型和时间范围。例如：'MTBE 产能利用率 2026年'、'隆众资讯 化工品开工率 2026'",
        },
        max_results: {
          type: "number",
          description: "返回结果的最大数量，默认10，范围1-20",
          default: 10,
        },
        search_type: {
          type: "string",
          enum: ["general", "news", "data"],
          description: "搜索类型：general-通用搜索，news-新闻，data-数据报告。默认general",
          default: "general",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * 执行联网搜索工具调用
 * @param {object} args - 工具调用参数
 * @param {string} args.query - 搜索查询
 * @param {number} [args.max_results=10] - 最大结果数
 * @param {string} [args.search_type="general"] - 搜索类型
 * @returns {Promise<object>} 搜索结果
 */
export async function executeWebSearchTool(args) {
  const query = String(args?.query || "").trim();
  if (!query) {
    return {
      success: false,
      error: "查询不能为空",
      results: [],
    };
  }

  const maxResults = Math.min(20, Math.max(1, Number(args?.max_results) || 10));
  const searchType = String(args?.search_type || "general");

  console.log(`[tool.web_search] query="${query}" max=${maxResults} type=${searchType}`);

  try {
    // 尝试多个搜索源
    let results = [];

    // 1. 优先使用MCP Web Search（如果配置了）
    if (process.env.BRAVE_API_KEY) {
      try {
        const braveResults = await searchBraveWeb(query, {
          count: maxResults,
          freshness: searchType === "news" ? "pd" : undefined, // past day for news
        });
        results = results.concat(braveResults || []);
      } catch (err) {
        console.warn(`[tool.web_search] Brave search failed:`, err.message);
      }
    }

    // 2. 如果Brave没有配置或结果不足，尝试其他源
    if (results.length < 3) {
      // 尝试Tavily
      if (process.env.TAVILY_API_KEY) {
        try {
          const tavilyResults = await searchTavilyWeb(query, { maxResults });
          results = results.concat(tavilyResults || []);
        } catch (err) {
          console.warn(`[tool.web_search] Tavily search failed:`, err.message);
        }
      }

      // 尝试Dataify
      if (results.length < 3 && process.env.DATAIFY_API_KEY) {
        try {
          const dataifyResults = await searchDataifyWeb(query, { limit: maxResults });
          results = results.concat(dataifyResults || []);
        } catch (err) {
          console.warn(`[tool.web_search] Dataify search failed:`, err.message);
        }
      }

      // 尝试MCP
      if (results.length < 3) {
        try {
          const mcpResults = await searchMcpWeb(query, { limit: maxResults });
          results = results.concat(mcpResults || []);
        } catch (err) {
          console.warn(`[tool.web_search] MCP search failed:`, err.message);
        }
      }
    }

    // 去重并限制数量
    const uniqueResults = deduplicateResults(results).slice(0, maxResults);

    // 格式化返回结果
    const formattedResults = uniqueResults.map((r, idx) => ({
      index: idx + 1,
      title: String(r.title || "").slice(0, 200),
      url: String(r.absUrl || r.url || ""),
      snippet: String(r.summary || r.abstract || r.snippet || "").slice(0, 500),
      source: r.source || "web",
      relevance_score: r.relevanceScore || r.score || 0,
    }));

    console.log(`[tool.web_search] Found ${formattedResults.length} results for "${query}"`);

    return {
      success: true,
      query,
      count: formattedResults.length,
      results: formattedResults,
    };
  } catch (error) {
    console.error(`[tool.web_search] Error:`, error);
    return {
      success: false,
      error: error.message || "搜索失败",
      results: [],
    };
  }
}

/**
 * 去重搜索结果（基于URL）
 */
function deduplicateResults(results) {
  const seen = new Set();
  const unique = [];

  for (const result of results) {
    const url = String(result.absUrl || result.url || "").trim();
    if (!url || seen.has(url)) continue;

    seen.add(url);
    unique.push(result);
  }

  return unique;
}

/**
 * 格式化工具调用结果为文本（供模型阅读）
 * @param {object} result - executeWebSearchTool的返回结果
 * @returns {string} 格式化的文本
 */
export function formatWebSearchResult(result) {
  if (!result.success) {
    return `搜索失败：${result.error}`;
  }

  if (!result.results || result.results.length === 0) {
    return `未找到"${result.query}"的相关结果`;
  }

  let text = `搜索 "${result.query}" 找到 ${result.count} 条结果：\n\n`;

  for (const item of result.results) {
    text += `[${item.index}] ${item.title}\n`;
    text += `URL: ${item.url}\n`;
    text += `摘要: ${item.snippet}\n`;
    if (item.relevance_score > 0) {
      text += `相关度: ${item.relevance_score.toFixed(2)}\n`;
    }
    text += `\n`;
  }

  return text;
}

/**
 * 处理模型的工具调用请求
 * @param {object} toolCall - 模型返回的tool_call对象
 * @returns {Promise<string>} 工具执行结果（文本格式）
 */
export async function handleToolCall(toolCall) {
  const functionName = toolCall?.function?.name;

  if (functionName !== "web_search") {
    return `错误：未知的工具 "${functionName}"`;
  }

  let args;
  try {
    args = typeof toolCall.function.arguments === "string"
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function.arguments;
  } catch (err) {
    return `错误：无法解析工具参数 - ${err.message}`;
  }

  const result = await executeWebSearchTool(args);
  return formatWebSearchResult(result);
}
