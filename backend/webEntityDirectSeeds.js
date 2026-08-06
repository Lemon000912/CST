/**
 * 当公共 SERP（DDG/SearX 等）在国内不可用或 Bing 误解析时，注入已知官网/披露页种子链接。
 */
import crypto from "node:crypto";

function stableWebId(url) {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 22);
}

function seedPaper(title, url, summary, sourceLabel = "entity_seed") {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(u)) return null;
  const id = stableWebId(u);
  const text = String(summary || title).slice(0, 1200);
  return {
    paper_id: `${sourceLabel}:${id}`,
    doi: null,
    title: String(title || u).slice(0, 400),
    abstract: text,
    year: null,
    venue: "Web (entity seed)",
    oa_status: null,
    authors_json: JSON.stringify([]),
    authors: [],
    summary: text.slice(0, 800),
    published: "",
    id,
    absUrl: u,
    pdfUrl: u,
    source: sourceLabel,
    isReferencedByCount: null,
  };
}

/**
 * @param {string} rawQuery
 * @returns {object[]}
 */
export function buildEntityDirectWebSeeds(rawQuery) {
  const raw = String(rawQuery ?? "").trim();
  if (!raw) return [];

  const out = [];
  const push = (title, url, summary) => {
    const p = seedPaper(title, url, summary);
    if (p) out.push(p);
  };

  if (/宁波\s*新\s*合成|宁波新合成|新和成|xinhecheng|NHU|002001/i.test(raw)) {
    push(
      "浙江新和成股份有限公司（官网）",
      "https://www.cnhu.com/",
      "新和成 NHU：营养品、香精香料、高分子新材料、原料药等业务；投资者关系与产品信息见官网。",
    );
    push(
      "巨潮资讯 - 002001 新和成 信息披露",
      "https://www.cninfo.com.cn/new/disclosure/stock?stockCode=002001",
      "深交所上市公司 002001 浙江新和成股份有限公司公告、年报、主营业务等法定披露。",
    );
    push(
      "东方财富 - 新和成(002001) 公司概况",
      "https://quote.eastmoney.com/sz002001.html",
      "002001 新和成：公司简介、主营构成、财务与行情（东方财富）。",
    );
    push(
      "同花顺 - 新和成 002001",
      "https://basic.10jqka.com.cn/002001/",
      "新和成 002001 主营介绍、产品与公司资料（同花顺 F10）。",
    );
  }

  if (/宁波新容|王子新材/i.test(raw)) {
    push(
      "王子新材 - 宁波新容电器",
      "https://www.wangzi.com/",
      "王子新材及子公司宁波新容：薄膜电容等产品。",
    );
  }

  return out;
}
