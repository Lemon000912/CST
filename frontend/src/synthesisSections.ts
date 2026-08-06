/** 综述 Markdown 中「间接参考」独立小节的标题（与后端 synthesize.js 约定一致） */
export const INDIRECT_SYNTH_HEADING = "## 间接参考与延伸线索";

const INDIRECT_HEADING_RE =
  /^##\s*(间接参考(?:与延伸线索)?|延伸线索与类比参考|间接引用)\s*$/im;

export type SplitSynthesisResult = {
  /** 直接回答用户问题的正文（不含间接参考小节） */
  directMarkdown: string;
  /** 间接/类比/延伸参考，无则空串 */
  indirectMarkdown: string;
  hasIndirectSection: boolean;
};

/**
 * 将 LLM 综述拆成「直接结论」与「间接参考」，避免两类内容混在同一段落里展示。
 */
export function splitSynthesisMarkdown(markdown: string): SplitSynthesisResult {
  const raw = String(markdown ?? "").trim();
  if (!raw) {
    return { directMarkdown: "", indirectMarkdown: "", hasIndirectSection: false };
  }

  const m = raw.match(INDIRECT_HEADING_RE);
  if (!m || m.index == null) {
    return { directMarkdown: raw, indirectMarkdown: "", hasIndirectSection: false };
  }

  const directMarkdown = raw.slice(0, m.index).trim();
  const indirectMarkdown = raw.slice(m.index + m[0].length).trim();

  return {
    directMarkdown: directMarkdown || "",
    indirectMarkdown,
    hasIndirectSection: true,
  };
}
