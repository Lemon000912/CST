/**
 * 从带「对话上下文」的检索串中抽出本次真正要问的一句，避免 Crossref/arXiv 等 URL 过长 (414)。
 * @param {string} raw
 * @returns {string}
 */
function stripConversationalMeta(s) {
  let t = String(s ?? "").trim();
  if (!t) return "";

  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t
      .replace(
        /^(?:结合|根据|参考|延续|接着|基于|按照)(?:上(?:文|一轮|面|述|条|次)|先前|之前|前面)?(?:的)?(?:回答|内容|讨论|话题|问题|说法|观点)[，,、：:\s]*/u,
        "",
      )
      .replace(/^(?:以及|还有|另外|同时|并且|再|再补充|再帮我)[，,、：:\s]*/u, "")
      .replace(/^(?:请|帮我|麻烦|能否|可以)[，,、：:\s]*/u, "")
      .replace(/^(?:关于|针对|对于)[，,、：:\s]*/u, "");
    if (t === before) break;
  }

  /** 去掉「上文的回答」类嵌套引用，保留实质问句 */
  t = t
    .replace(/(?:上(?:文|一轮|面|述)|先前|之前)(?:的)?回答[，,、：:\s]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  /** 超长时优先取带问号的短句 */
  if (t.length > 100) {
    const qs = [...t.matchAll(/[^，,。！!？?\n]{4,120}[？?]/gu)];
    if (qs.length) {
      const pick = qs[qs.length - 1][0];
      if (pick.length >= 6 && pick.length < t.length * 0.85) t = pick.trim();
    }
  }

  return t.trim();
}

export function extractCoreSearchQuery(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const curMark = /----\s*当前提问\s*----/i;
  const m = curMark.exec(s);
  if (m && m.index >= 0) {
    const after = s.slice(m.index + m[0].length).trim();
    if (after) {
      const current = after.split(/\n{2,}/)[0].trim();
      return current.length > 1200 ? current.slice(0, 1200) : current;
    }
  }

  if (/【对话上下文|【本对话上文/.test(s)) {
    const users = [...s.matchAll(/用户[：:]\s*([^\n]+)/g)];
    const last = users[users.length - 1];
    if (last?.[1]?.trim()) return last[1].trim().slice(0, 1200);
  }

  /** 单句提问：仅去掉开头礼貌/引用套话，不删句中实质内容 */
  if (s.length <= 200) {
    const light = stripConversationalMeta(s);
    return light.length >= 4 ? light : s;
  }

  const stripped = stripConversationalMeta(s);
  const out = stripped || s;
  return out.length > 1200 ? out.slice(0, 1200) : out;
}

/**
 * 从合并串中拆出对话上文（供改写/综述），不含「当前提问」段。
 * @param {string} raw
 * @returns {string}
 */
export function extractConversationContext(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const curMark = /----\s*当前提问\s*----/i;
  const m = curMark.exec(s);
  if (m && m.index > 0) {
    return s.slice(0, m.index).trim().slice(0, 8000);
  }

  if (/【对话上下文|【本对话上文/.test(s)) {
    const beforeCurrent = s.split(curMark)[0]?.trim();
    if (beforeCurrent) return beforeCurrent.slice(0, 8000);
    return s.slice(0, 8000);
  }

  return "";
}

/**
 * 网页 SERP 用检索词：去掉「什么/怎么」等疑问虚词，避免 Bing 只匹配到「什么」一词的百科页。
 * @param {string} raw
 */
export function extractWebSearchQuery(raw) {
  let q = extractCoreSearchQuery(raw) || String(raw ?? "").trim();
  q = q
    .replace(/【[^】]*】/g, " ")
    .replace(/----[\s\S]*?----/g, " ")
    .replace(
      /(?:什么|怎么|如何|为什么|哪些|怎样|哪个|请问|问一下|想知道|帮我|告诉我|吗|呢|嘛|呀|吧)(?=\s|$|[，,。])/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (q.length < 3) {
    q = extractCoreSearchQuery(raw) || String(raw ?? "").trim();
  }
  return clampQueryForExternalApi(q, 280);
}

/** 外网 API 检索词长度上限（query 参数进 URL） */
export function clampQueryForExternalApi(q, maxLen = 400) {
  const s = String(q ?? "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trim();
}
