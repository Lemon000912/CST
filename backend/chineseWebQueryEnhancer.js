/**
 * 中文专业网站查询增强
 *
 * 针对化工、材料等专业领域的中文查询，添加专业网站名称或领域关键词
 * 提高在 Bing CN、Tavily 等搜索引擎中命中专业数据网站的概率
 */

/**
 * 专业数据网站关键词映射
 * 根据查询内容特征，自动添加相关网站名称
 */
const PROFESSIONAL_SITE_KEYWORDS = {
  // 化工产能、开工率、价格数据
  chemical_capacity: {
    triggers: ["产能", "开工率", "利用率", "产量", "装置", "工厂"],
    sites: ["隆众资讯", "卓创资讯", "百川盈孚", "Oilchem", "我的钢铁网"],
    weight: 0.8,
  },
  // 化工价格、行情
  chemical_price: {
    triggers: ["价格", "行情", "报价", "走势", "涨跌"],
    sites: ["卓创资讯", "隆众资讯", "生意社"],
    weight: 0.7,
  },
  // 钢铁、金属
  metal: {
    triggers: ["钢铁", "钢材", "铁矿", "螺纹钢", "热轧", "冷轧", "不锈钢"],
    sites: ["我的钢铁网", "钢联数据"],
    weight: 0.9,
  },
  // 行业报告、分析
  industry_report: {
    triggers: ["行业", "市场", "分析", "报告", "研究", "趋势", "前景"],
    sites: ["国研网", "中研网", "发现报告"],
    weight: 0.6,
  },
};

/**
 * 检测查询是否包含特定触发词
 * @param {string} query
 * @param {string[]} triggers
 * @returns {number} 匹配程度 0-1
 */
function matchTriggers(query, triggers) {
  const q = query.toLowerCase();
  let matchCount = 0;
  for (const trigger of triggers) {
    if (q.includes(trigger)) {
      matchCount++;
    }
  }
  return matchCount / triggers.length;
}

/**
 * 为中文查询添加专业网站关键词
 * @param {string} query
 * @returns {{enhanced: string, sites: string[], note: string}}
 */
export function enhanceChineseWebQuery(query) {
  const q = String(query ?? "").trim();

  // 只处理中文查询
  if (!/[一-龥]/.test(q)) {
    return { enhanced: q, sites: [], note: "not-chinese" };
  }

  // 如果查询已经包含网站名称，不重复添加
  const existingSites = [];
  for (const category of Object.values(PROFESSIONAL_SITE_KEYWORDS)) {
    for (const site of category.sites) {
      if (q.includes(site)) {
        existingSites.push(site);
      }
    }
  }

  if (existingSites.length > 0) {
    return { enhanced: q, sites: existingSites, note: "already-has-sites" };
  }

  // 匹配专业领域
  let bestMatch = null;
  let bestScore = 0;

  for (const [category, config] of Object.entries(PROFESSIONAL_SITE_KEYWORDS)) {
    const score = matchTriggers(q, config.triggers) * config.weight;
    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestMatch = { category, config };
    }
  }

  // 如果匹配到专业领域，添加2个最相关的网站名称
  if (bestMatch) {
    const sites = bestMatch.config.sites.slice(0, 2);
    const enhanced = `${q} ${sites.join(" ")}`;
    return {
      enhanced,
      sites,
      note: `enhanced:${bestMatch.category}:score=${bestScore.toFixed(2)}`,
    };
  }

  return { enhanced: q, sites: [], note: "no-match" };
}

/**
 * 生成多个查询变体（用于并行搜索）
 * @param {string} query
 * @returns {string[]} 查询变体列表
 */
export function generateChineseWebQueryVariants(query) {
  const q = String(query ?? "").trim();
  const variants = [q]; // 原始查询

  // 只处理中文查询
  if (!/[一-龥]/.test(q)) {
    return variants;
  }

  // 生成带不同网站关键词的变体
  for (const [category, config] of Object.entries(PROFESSIONAL_SITE_KEYWORDS)) {
    const score = matchTriggers(q, config.triggers) * config.weight;
    if (score > 0.4) {
      // 为每个高匹配度的类别生成一个变体
      const site = config.sites[0];
      if (!q.includes(site)) {
        variants.push(`${q} ${site}`);
      }
    }
  }

  // 最多返回3个变体（避免过度查询）
  return variants.slice(0, 3);
}

/**
 * 为查询添加领域上下文（用于提高相关性）
 * @param {string} query
 * @returns {{query: string, context: string}}
 */
export function addDomainContext(query) {
  const q = String(query ?? "").trim();

  if (!/[一-龥]/.test(q)) {
    return { query: q, context: "" };
  }

  // 检测是否是化工/材料领域查询
  const isChemical = /化工|化学品|聚合物|树脂|塑料|橡胶|纤维|溶剂|单体|烯烃|芳烃|醇|酯|酮|醚|胺/i.test(q);
  const isMetal = /钢铁|金属|合金|矿石|有色|铜|铝|锌|镍/i.test(q);

  if (isChemical) {
    return {
      query: q,
      context: "化工行业专业数据",
    };
  }

  if (isMetal) {
    return {
      query: q,
      context: "钢铁金属行业数据",
    };
  }

  return { query: q, context: "" };
}
