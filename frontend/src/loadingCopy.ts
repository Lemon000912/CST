import type { SearchChannel } from "./types";

/** 主对话区：发送后等待 /api/v1/search 的提示文案 */
export function getMainSearchLoadingText(opts: {
  channel: SearchChannel;
  patentsOnly: boolean;
  deepMine: boolean;
}): string {
  if (opts.patentsOnly) return "正在搜索专利公开信息…";
  if (opts.deepMine) return "正在深度分析（下载并解析全文），可能需要几分钟…";
  if (opts.channel === "web") return "正在全网搜索，双模型作答与第三模型仲裁中…";
  return "正在检索数据库与全网资料，并汇总综述…";
}

export const LOADING_UPLOAD = "正在解析上传文件…";
export const LOADING_CHART = "正在生成图表…";
export const LOADING_DATA_TABLE = "正在生成数据表…";
export const LOADING_OA = "正在查询开放获取链接…";
export const LOADING_EXPORT = "导出中…";
export const LOADING_AUTH = "请稍候…";
export const LOADING_PDF = "正在生成 PDF…";
