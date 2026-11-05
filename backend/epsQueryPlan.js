import { resolvePrimaryProvider, resolveProviderSlot } from "./llmProviders.js";
import { generateText } from "./llmClient.js";
import { buildEpsDiscoveryQueries } from "./europeanPublicationServer.js";

export async function planEpsSearch(query, { effectiveQuery, signal } = {}) {
  const fallback = { queries: buildEpsDiscoveryQueries(query, effectiveQuery), ipcCodes: [] };
  const provider = resolveProviderSlot("B") || resolvePrimaryProvider();
  if (!provider) return fallback;
  const result = await generateText(provider, {
    signal, timeoutMs: 6000, temperature: 0, maxTokens: 512,
    system: '将问题转换为欧洲专利检索计划。只输出 JSON：{"queries":["英文关键词"],"ipcCodes":["G01N17/00"]}。给出最多3条英文检索词，每条3到8个词，必须保留对象和待解决问题/被测量；第一条保留约束，另外两条用同义词并放宽安装环境等约束。另给最多2个最相关的IPC完整分类号，不确定可为空。腐蚀检测应保留corrosion及measurement/detection/monitoring，不能退化成单纯电压测量；不要返回专利编号或链接，不要根据记忆补专利。',
    messages: [{ role: "user", content: `${String(query).slice(0, 900)}\n已有英文关键词：${String(effectiveQuery || "").slice(0, 400)}` }],
  });
  try {
    const text = String(result.text || "");
    const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const queries = (Array.isArray(data.queries) ? data.queries : []).filter(q => typeof q === "string" && /^[a-z\s-]{5,100}$/i.test(q.trim())).map(q => buildEpsDiscoveryQueries(q)[0]);
    const ipcCodes = (Array.isArray(data.ipcCodes) ? data.ipcCodes : []).map(c => String(c).toUpperCase().replace(/\s/g, "")).filter(c => /^[A-H]\d{2}[A-Z]\d{1,3}\/\d{1,3}$/.test(c));
    return { queries: [...new Set(queries.length ? queries : fallback.queries)].slice(0, 3), ipcCodes: [...new Set(ipcCodes)].slice(0, 2) };
  } catch { return fallback; }
}
