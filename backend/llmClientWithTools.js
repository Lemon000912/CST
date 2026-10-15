/**
 * 支持Function Calling的LLM客户端增强版
 * 允许模型主动调用工具（如联网搜索）
 */

import { generateText } from "./llmClient.js";
import {
  WEB_SEARCH_TOOL_DEFINITION,
  WEB_OPEN_URL_TOOL_DEFINITION,
  handleToolCall,
} from "./webSearchTool.js";

const MAX_TOOL_ITERATIONS = 5; // 允许模型进行多轮检索、补查和最终核对

/**
 * 生成文本，支持工具调用
 * @param {object} provider - LLM provider配置
 * @param {object} request - 请求参数
 * @param {string} request.system - System prompt
 * @param {object[]} request.messages - 对话消息
 * @param {boolean} [request.enableWebSearch=false] - 是否启用联网搜索工具
 * @param {number} [request.maxToolIterations=3] - 最大工具调用轮次
 * @returns {Promise<object>} { text, usage, toolCalls }
 */
export async function generateTextWithTools(provider, request) {
  const enableWebSearch = request.enableWebSearch ?? false;
  const configuredMax = Number(process.env.WEB_TOOL_MAX_ITERATIONS) || MAX_TOOL_ITERATIONS;
  const maxIterations = Math.min(6, Math.max(1, request.maxToolIterations || configuredMax));

  // 如果不启用工具，直接调用原生generateText
  if (!enableWebSearch) {
    const result = await generateText(provider, request);
    return {
      text: result?.text || "",
      usage: result?.usage,
      toolCalls: [],
    };
  }

  console.log(`[llm.tools] Enabled web_search tool, max iterations: ${maxIterations}`);

  const messages = [...(request.messages || [])];
  const toolCalls = [];
  let finalText = "";
  let finalUsage = null;

  // 工具调用循环
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    console.log(`[llm.tools] Iteration ${iteration + 1}/${maxIterations}`);

    // 构建包含工具定义的请求
    const llmRequest = {
      ...request,
      messages,
      tools: [WEB_SEARCH_TOOL_DEFINITION, WEB_OPEN_URL_TOOL_DEFINITION],
      tool_choice: iteration === 0 && request.forceWebSearch
        ? { type: "function", function: { name: "web_search" } }
        : "auto",
    };

    // 调用LLM（带工具定义）
    const result = await generateTextWithToolSupport(provider, llmRequest);

    if (!result) {
      console.warn(`[llm.tools] No result from LLM at iteration ${iteration + 1}`);
      break;
    }

    finalUsage = result.usage;

    // 检查是否有工具调用
    const hasToolCall = result.tool_calls && result.tool_calls.length > 0;

    if (!hasToolCall) {
      // 没有工具调用，这是最终答案
      finalText = result.text || "";
      console.log(`[llm.tools] Final answer received (no tool call)`);
      break;
    }

    // 处理工具调用
    console.log(`[llm.tools] Processing ${result.tool_calls.length} tool call(s)`);

    // 添加助手的工具调用消息
    messages.push({
      role: "assistant",
      content: result.text || "",
      tool_calls: result.tool_calls,
    });

    // 执行每个工具调用
    for (const toolCall of result.tool_calls) {
      const toolCallId = toolCall.id || `call_${Date.now()}`;
      const functionName = toolCall.function?.name;

      console.log(`[llm.tools] Executing tool: ${functionName}`);
      toolCalls.push({
        iteration: iteration + 1,
        function: functionName,
        arguments: toolCall.function?.arguments,
      });

      try {
        // 执行工具
        const toolResult = await handleToolCall(toolCall);

        // 添加工具结果消息
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          name: functionName,
          content: toolResult,
        });

        console.log(`[llm.tools] Tool executed successfully, result length: ${toolResult.length}`);
      } catch (error) {
        console.error(`[llm.tools] Tool execution failed:`, error);
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          name: functionName,
          content: `工具执行失败: ${error.message}`,
        });
      }
    }

    // 如果是最后一轮迭代，强制要求模型给出最终答案
    if (iteration === maxIterations - 1) {
      console.log(`[llm.tools] Last iteration, requesting final answer`);
      messages.push({
        role: "user",
        content: "请基于以上搜索结果，给出完整的回答。",
      });
    }
  }

  // 如果循环结束仍没有最终答案，再调用一次获取
  if (!finalText) {
    console.log(`[llm.tools] Requesting final synthesis`);
    const finalRequest = {
      ...request,
      messages,
      tools: undefined, // 不再提供工具，强制返回文本
    };
    const finalResult = await generateText(provider, finalRequest);
    finalText = finalResult?.text || "";
    finalUsage = finalResult?.usage || finalUsage;
  }

  console.log(`[llm.tools] Completed with ${toolCalls.length} total tool calls`);

  return {
    text: finalText,
    usage: finalUsage,
    toolCalls,
  };
}

/**
 * 调用LLM并解析工具调用
 * 支持OpenAI和兼容格式的Function Calling
 */
async function generateTextWithToolSupport(provider, request) {
  // 构建请求body
  const body = {
    model: provider.model,
    messages: request.messages,
    ...(request.system ? { system: request.system } : {}),
    ...(Number.isFinite(request.temperature) ? { temperature: request.temperature } : {}),
    ...(Number.isFinite(request.maxTokens) ? { max_tokens: request.maxTokens } : {}),
  };

  // 添加工具定义（如果有）
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice;
    }
  }

  // 调用API
  const controller = new AbortController();
  const timeoutMs = Math.min(360_000, Math.max(1_000, Number(request.timeoutMs) || 120_000));
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(provider.baseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[llm.tools] API error ${response.status}:`, errorText);
      return null;
    }

    const json = await response.json();

    // 解析响应
    const choice = json.choices?.[0];
    if (!choice) return null;

    const message = choice.message;
    const text = message?.content || "";
    const toolCalls = message?.tool_calls || [];

    return {
      text,
      tool_calls: toolCalls,
      usage: json.usage,
    };
  } catch (error) {
    console.error(`[llm.tools] Request failed:`, error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 检查LLM Provider是否支持Function Calling
 * @param {object} provider
 * @returns {boolean}
 */
export function providerSupportsTools(provider) {
  // 大多数OpenAI兼容的API都支持Function Calling
  // Gemini需要特殊处理（暂不支持）
  if (provider.protocol === "GEMINI") {
    return false;
  }

  // OpenAI、Deepseek、Qwen等都支持
  return true;
}
