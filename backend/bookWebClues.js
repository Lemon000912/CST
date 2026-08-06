/**
 * 书籍类问题：从书名出发，用多组公开网页检索词拼「定位 + 目录/章节」线索。
 */
import { extractCoreSearchQuery, clampQueryForExternalApi } from "./searchQueryNormalize.js";

/** 明确指向图书/读物的问法（勿用单独的「主要内容/目录」等泛词，否则会误判普通技术问答） */
const BOOK_INTENT_STRONG_RE =
  /《[^》]{2,48}》|这本书|该书|此书|这本|哪本书|什么书|图书|书籍|专著|教科书|读书|读后感|豆瓣读书/i;

/** 网页上像「书讯 / 目录 / 书评 / 出版社」的页面 */
export const BOOK_CLUE_PAGE_RE =
  /目录|章节|第\s*[一二三四五六七八九十\d]+\s*章|Chapter\s*\d|Table of Contents|内容简介|内容提要|推荐序|序言|前言|致谢|作者简介|译者|出版社|出版信息|豆瓣读书|subject\/\d{5,}|technicspub\.com|leanpub|harvard\.com\/book|goodreads|WorldCat|ISBN|丛书|平装|精装|机械工业出版社|人民邮电|清华大学出版社|Data Strategies for Data Governance|数据战略实践手册/i;

/**
 * @param {string} q
 */
export function isBookIntentQuery(q) {
  const s = String(q ?? "").trim();
  if (!s) return false;
  if (BOOK_INTENT_STRONG_RE.test(s)) return true;
  const hasBookNoun = /书|《|专著|手册|教程|指南|读本|概论|导论/.test(s);
  if (!hasBookNoun) return false;
  if (/作者是谁|哪个作者|谁写的|出版社|ISBN|译者/.test(s)) return true;
  if (/(?:按章|分章|各章|章节).*(?:总结|概述|介绍|讲了|内容)/.test(s)) return true;
  if (/目录/.test(s) && /书|手册|教程|指南|专著/.test(s)) return true;
  if (/(?:主要内容|内容是什么|讲了什么|核心内容)/.test(s)) return true;
  return false;
}

/**
 * @param {string} q
 * @returns {string[]}
 */
export function extractBookTitles(q) {
  const text = String(q ?? "");
  const titles = [];
  const seen = new Set();
  for (const m of text.matchAll(/《([^》]{2,48})》/g)) {
    const t = String(m[1] ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    titles.push(t);
  }
  /** 无书名号时：「数据战略实践手册这本书」 */
  if (!titles.length) {
    const m2 = text.match(
      /([\u4e00-\u9fffA-Za-z0-9·\s]{4,32}(?:手册|指南|教程|概论|原理|导论|读本))(?:这本书|该书|此书|的目录|的主要内容)?/,
    );
    if (m2?.[1]) {
      const t = m2[1].trim();
      if (!seen.has(t)) titles.push(t);
    }
  }
  return titles.slice(0, 3);
}

/**
 * @param {string} title
 * @param {string} rawQuery
 * @returns {string[]}
 */
export function buildBookClueSearchQueries(title, rawQuery = "") {
  const t = String(title ?? "").trim().slice(0, 80);
  if (!t) return [];
  const seen = new Set();
  const out = [];
  const push = (q) => {
    const s = clampQueryForExternalApi(String(q ?? "").trim(), 380);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  push(`${t} 目录 章节`);
  push(`${t} 序言 内容简介 出版社`);
  push(`${t} 书评 推荐序 作者`);
  push(`${t} 豆瓣 读书`);
  push(`${t} table of contents chapter`);

  /** 已知中译本 ↔ 英文原著（可扩展） */
  if (/数据战略实践手册/.test(t)) {
    push("Data Strategies for Data Governance Marilu Lopez table of contents");
    push("数据战略实践手册 十步 PAC 玛丽露");
    push("site:technicspub.com Data Strategies Data Governance");
  }

  const rq = String(rawQuery ?? "");
  if (/章节|按章|分章|总结/.test(rq)) push(`${t} 各章 主要内容`);
  if (/作者|谁写/.test(rq)) push(`${t} 作者 简介`);

  return out.slice(0, 12);
}

/**
 * @param {string} rawQuery
 * @param {string} [effectiveQuery]
 * @returns {{ queries: string[]; titles: string[]; tags: string[] }}
 */
export function buildBookWebSearchPlan(rawQuery, effectiveQuery = "") {
  const core = extractCoreSearchQuery(rawQuery) || String(rawQuery ?? "").trim();
  if (!isBookIntentQuery(core)) {
    return { queries: [], titles: [], tags: [] };
  }
  const titles = extractBookTitles(core);
  if (!titles.length && /书|手册|专著|教程/.test(core)) {
    titles.push(core.replace(/(这本书|该书|请|总结|什么|如何|按照|章节).*/g, "").trim().slice(0, 40));
  }
  const seen = new Set();
  const queries = [];
  const tags = ["book_clue_mode"];
  for (const title of titles) {
    tags.push(`book:${title.slice(0, 24)}`);
    for (const q of buildBookClueSearchQueries(title, core)) {
      const s = clampQueryForExternalApi(q, 380);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      queries.push(s);
    }
  }
  return { queries, titles, tags };
}

/**
 * @param {object} p
 * @param {string[]} titles
 */
export function scoreBookCluePaper(p, titles) {
  const text = `${p.title || ""} ${p.summary || ""} ${p.absUrl || ""}`;
  let score = 0;
  for (const t of titles) {
    if (!t) continue;
    if (text.includes(t)) score += 85;
    const short = t.replace(/[：:].*$/, "").slice(0, 8);
    if (short.length >= 4 && text.includes(short)) score += 35;
  }
  if (BOOK_CLUE_PAGE_RE.test(text)) score += 45;
  if (/douban\.com\/subject|technicspub\.com|harvard\.com\/book/i.test(text)) score += 40;
  if (/百度百科.*(市|省|旅游)|游记|攻略/.test(text)) score -= 120;
  return score;
}

/**
 * @param {object} p
 * @param {string[]} titles
 */
export function isBookCluePaper(p, titles) {
  const text = `${p.title || ""} ${p.summary || ""}`;
  if (scoreBookCluePaper(p, titles) >= 70) return true;
  if (titles.some((t) => t && text.includes(t)) && BOOK_CLUE_PAGE_RE.test(text)) return true;
  return false;
}

/**
 * @param {object[]} papers
 * @param {string} rawQuery
 * @returns {string[]}
 */
export function inferBookFollowUpWebQueries(papers, rawQuery) {
  const core = extractCoreSearchQuery(rawQuery) || String(rawQuery ?? "").trim();
  if (!isBookIntentQuery(core)) return [];
  const titles = extractBookTitles(core);
  const blob = (Array.isArray(papers) ? papers : [])
    .slice(0, 30)
    .map((p) => `${p.title || ""} ${p.summary || ""}`)
    .join("\n");
  const out = [];
  const seen = new Set();
  const push = (q) => {
    const s = clampQueryForExternalApi(q, 380);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  for (const t of titles) {
    if (/Data Strategies|数据战略实践/.test(t) || /数据战略实践/.test(blob)) {
      push("Data Strategies for Data Governance Marilu Lopez chapter");
      push("technicspub data strategies data governance contents");
    }
    push(`${t} 目录 site:douban.com`);
    push(`${t} 章节 简介`);
  }
  return out.slice(0, 6);
}
