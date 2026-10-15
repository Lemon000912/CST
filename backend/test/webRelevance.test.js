import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWebAnswerTokens,
  pickWebPatentPapersForSynthesis,
  scoreWebPaperForAnswer,
} from "../webRelevance.js";

const query = "苯乙烯 2026年产能利用率和开工率";
const tokens = buildWebAnswerTokens(query);

test("industry metric evidence and named industry sources rank above chemical glossaries", () => {
  const industryPage = {
    title: "苯乙烯装置开工率持续走低",
    summary: "2026年10月苯乙烯行业开工率为64.44%，行业产能利用率偏低。",
    absUrl: "https://nenghua.mysteel.com/a/26001308/article.html",
    source: "ddg_web",
  };
  const glossaryPage = {
    title: "苯乙烯_百度百科",
    summary: "苯乙烯是一种重要的有机化工原料，广泛用于塑料和树脂生产。",
    absUrl: "https://baike.baidu.com/item/苯乙烯",
    source: "ddg_web",
  };

  assert.ok(
    scoreWebPaperForAnswer(industryPage, tokens, query, query) >
      scoreWebPaperForAnswer(glossaryPage, tokens, query, query),
  );
});

test("industry metric evidence boosts a page even when the SERP title is generic", () => {
  const withEvidence = {
    title: "10月化工品装置运行情况",
    summary: "苯乙烯产能利用率为64.44%。",
    absUrl: "https://www.oilchem.net/news/article.html",
    source: "tavily_web",
  };
  const withoutEvidence = {
    ...withEvidence,
    summary: "苯乙烯产业链市场运行分析。",
  };

  assert.ok(
    scoreWebPaperForAnswer(withEvidence, tokens, query, query) >
      scoreWebPaperForAnswer(withoutEvidence, tokens, query, query),
  );
});

test("multi-entity metric synthesis keeps one low-score page per covered entity", () => {
  const query = "产品甲、产品乙、产品丙、产品丁的产能利用率";
  const papers = ["甲", "乙", "丙", "丁"].map((name, index) => ({
    source: "ddg_web",
    title: `行业运行周报 ${index + 1}`,
    summary: "网页标题没有直接展示数值，正文抓取后再核验。",
    absUrl: `https://industry.example.com/${index + 1}`,
    _entityCoverage: true,
    _matchedEntities: [`产品${name}`],
  }));

  const picked = pickWebPatentPapersForSynthesis(papers, query, 12);
  assert.equal(picked.papers.length, 4);
  assert.deepEqual(
    new Set(picked.papers.flatMap((paper) => paper._matchedEntities || [])),
    new Set(["产品甲", "产品乙", "产品丙", "产品丁"]),
  );
});
