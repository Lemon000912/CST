/**
 * 查询错别字纠正与模糊匹配（材料/纺织领域常见笔误）。
 */

/** 常见错别字 → 规范写法（长词优先匹配） */
const ZH_TYPO_MAP = [
  ["聚脂纤维", "聚酯纤维"],
  ["聚脂", "聚酯"],
  ["聚氨脂", "聚氨酯"],
  ["聚胺脂", "聚氨酯"],
  ["丁苯像胶", "丁苯橡胶"],
  ["像胶", "橡胶"],
  ["玻纤", "玻璃纤维"],
  ["碳纤维", "碳纤维"],
  ["碳钎维", "碳纤维"],
  ["石墨烯", "石墨烯"],
  ["石墨稀", "石墨烯"],
  ["阻燃性", "阻燃"],
  ["细旦数", "细旦"],
  ["细旦丝", "细旦"],
  ["织物的", "织物"],
  ["涂科", "涂料"],
  ["涂层", "涂层"],
  ["合金钢", "合金"],
  ["钛合金", "钛合金"],
  ["钛合全", "钛合金"],
  ["氧化铝", "氧化铝"],
  ["氧化吕", "氧化铝"],
  ["半导体", "半导体"],
  ["半导休", "半导体"],
  ["光电子", "光电子"],
  ["光电子", "光电子"],
  ["激光器", "激光器"],
  ["激光机", "激光器"],
  ["耐侯", "耐候"],
  ["耐侯性", "耐候"],
  ["抗拉强渡", "抗拉强度"],
  ["强渡", "强度"],
  ["延伸率", "延伸率"],
  ["延申率", "延伸率"],
  ["热塑性", "热塑性"],
  ["热塑型", "热塑性"],
  ["热固型", "热固性"],
  ["热固性", "热固性"],
  ["复合材料", "复合材料"],
  ["符合材料", "复合材料"],
  ["纳米材料", "纳米材料"],
  ["纳迷材料", "纳米材料"],
  ["陶瓷材料", "陶瓷材料"],
  ["陶瓷", "陶瓷"],
  ["金属间化合物", "金属间化合物"],
  ["金属间化和物", "金属间化合物"],
];

/** 英文常见拼写错误 */
const EN_TYPO_MAP = [
  ["polyester", "polyester"],
  ["polyurathane", "polyurethane"],
  ["polyurthane", "polyurethane"],
  ["polyurethene", "polyurethane"],
  ["flam retardant", "flame retardant"],
  ["flame retardan", "flame retardant"],
  ["graphen", "graphene"],
  ["grafene", "graphene"],
  ["semiconducter", "semiconductor"],
  ["aluminium", "aluminum"],
  ["fibre", "fiber"],
  ["microfibre", "microfiber"],
];

/**
 * @param {string} query
 * @returns {{ corrected: string; fixes: string[]; hadTypo: boolean }}
 */
export function correctQueryTypos(query) {
  let s = String(query ?? "").trim();
  if (!s) return { corrected: s, fixes: [], hadTypo: false };

  const fixes = [];
  const allMaps = [...ZH_TYPO_MAP, ...EN_TYPO_MAP].sort((a, b) => b[0].length - a[0].length);

  for (const [wrong, right] of allMaps) {
    if (wrong === right) continue;
    if (!s.includes(wrong)) continue;
    const re = new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (re.test(s)) {
      s = s.replace(re, right);
      fixes.push(`${wrong}→${right}`);
    }
  }

  return {
    corrected: s,
    fixes: [...new Set(fixes)].slice(0, 8),
    hadTypo: fixes.length > 0,
  };
}

/**
 * 中文编辑距离（仅用于短词模糊匹配，maxDist=1）。
 * @param {string} a
 * @param {string} b
 */
export function zhEditDistance(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  if (Math.abs(x.length - y.length) > 1) return 2;

  const m = x.length;
  const n = y.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * 文本是否包含 token（精确或 1 字编辑距离模糊，仅中文≥3字 / 英文≥4字母）。
 * @param {string} text
 * @param {string} token
 */
export function fuzzyTokenMatch(text, token) {
  const raw = String(text ?? "");
  const t = String(token ?? "").trim();
  if (!t || t.length < 2) return false;
  if (raw.includes(t)) return true;

  if (/[\u4e00-\u9fff]/.test(t) && t.length >= 3) {
    const phrases = raw.match(/[\u4e00-\u9fff]{2,12}/g) ?? [];
    for (const ph of phrases) {
      if (ph.length < t.length - 1 || ph.length > t.length + 1) continue;
      if (zhEditDistance(ph, t) <= 1) return true;
      if (ph.includes(t) || t.includes(ph)) return true;
    }
    return false;
  }

  const tl = t.toLowerCase();
  const blob = raw.toLowerCase();
  if (tl.length >= 4 && blob.includes(tl)) return true;
  if (tl.length >= 5) {
    const words = blob.match(/[a-z]{3,20}/g) ?? [];
    for (const w of words) {
      if (Math.abs(w.length - tl.length) > 1) continue;
      if (zhEditDistance(w, tl) <= 1) return true;
    }
  }
  return false;
}
