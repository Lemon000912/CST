/**
 * 检索召回模式：放宽网页收录与综合摘录门槛（仍剔除明显跑题页）。
 * WEB_SEARCH_RECALL=1（默认）偏召回；=0 偏精准（更少条数、更少跑题）。
 */
export function webSearchRecallMode() {
  return !/^(0|false|off|no)$/i.test(String(process.env.WEB_SEARCH_RECALL ?? "1").trim());
}

/** @param {boolean} [corp] 企业/产品问法 */
export function webIncludeMinScore(corp = false) {
  const env = Number(process.env.WEB_INCLUDE_MIN_SCORE);
  if (Number.isFinite(env) && env > 0) return env;
  return webSearchRecallMode() ? (corp ? 8 : 7) : corp ? 12 : 10;
}
