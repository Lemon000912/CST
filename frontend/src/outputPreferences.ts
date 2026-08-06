const STORAGE_KEY = "quantum-pinnacle-output-prefs-v1";
const MAX_ENTRIES = 18;

export type DissatisfactionEntry = {
  ts: number;
  aspects: string[];
  note?: string;
};

export const DISLIKE_ASPECTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "papers_irrelevant", label: "推荐的文献不相关或质量差" },
  { id: "synthesis_long", label: "综述/结论太长或啰嗦" },
  { id: "synthesis_inaccurate", label: "综述与文献不符或空洞" },
  { id: "deep_block", label: "深度解析整块不想要" },
  { id: "chart_block", label: "自动图表/数值抽取不需要" },
  { id: "meta_noise", label: "渠道、数据源等技术说明太多" },
  { id: "other", label: "其它（请在说明里写清）" },
];

const ASPECT_LLM_HINT: Record<string, string> = {
  papers_irrelevant:
    "后续回答中尽量少强调「文献列表」本身；综述须紧扣用户问题，少推荐明显跑题的篇目式罗列；若摘录不足宁可写「证据有限」也不要凑篇数；跑题或仅类比条目只能写在「## 间接参考与延伸线索」并以【间接】标明，不得与直接结论混写；与问题明显无关的网页/专利不要放在综述靠前位置。",
  synthesis_long: "综述与分节说明尽量精炼，删去套话与重复句，总篇幅明显缩短。",
  synthesis_inaccurate: "综述须严格贴合所给摘录，避免推断与夸大；不确定处明确标注依据不足。",
  deep_block: "不要模仿「深度解析」式长篇分点；避免过度展开与文献摘录无关的发挥。",
  chart_block: "不要在文字中引导或强调「请作图」「可画折线图」等图表话术，专注文字结论。",
  meta_noise: "不要在综述中复述检索渠道、数据源标签、改写说明等技术元信息。",
  other: "遵守用户在「其它说明」中写明的具体要求。",
};

function loadRaw(): DissatisfactionEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) return [];
    const out: DissatisfactionEntry[] = [];
    for (const x of j) {
      if (!x || typeof x !== "object") continue;
      const ts = Number((x as DissatisfactionEntry).ts);
      const aspects = (x as DissatisfactionEntry).aspects;
      if (!Number.isFinite(ts) || !Array.isArray(aspects)) continue;
      const note =
        typeof (x as DissatisfactionEntry).note === "string"
          ? (x as DissatisfactionEntry).note!.slice(0, 500)
          : undefined;
      const cleanAspects = aspects
        .map((a) => String(a).trim())
        .filter((a) => DISLIKE_ASPECTS.some((d) => d.id === a));
      if (!cleanAspects.length && !(note && note.trim().length > 1)) continue;
      out.push({ ts, aspects: cleanAspects, note });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function saveRaw(entries: DissatisfactionEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* ignore */
  }
}

/** 记录一次「不满意」维度（与是否已调 API 无关，仅存本机） */
export function addDissatisfactionEntry(entry: { aspects: string[]; note?: string }) {
  const aspects = [...new Set(entry.aspects.map((a) => String(a).trim()).filter(Boolean))].filter((a) =>
    DISLIKE_ASPECTS.some((d) => d.id === a),
  );
  const note = entry.note?.trim().slice(0, 500) || undefined;
  if (!aspects.length && !(note && note.length > 1)) return;
  if (aspects.includes("other") && (!note || note.length < 3)) return;
  const prev = loadRaw();
  prev.unshift({ ts: Date.now(), aspects, note });
  saveRaw(prev);
}

export function clearOutputPreferences() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function listDissatisfactionEntries(): DissatisfactionEntry[] {
  return loadRaw();
}

/**
 * 供 POST /api/v1/search 的 outputAvoidance 字段：压缩后的中文指令，供综述模型遵守。
 */
export function getOutputAvoidanceForRequest(): string {
  const entries = loadRaw();
  if (!entries.length) return "";
  const recent = entries.slice(0, 8);
  const aspectSet = new Set<string>();
  const notes: string[] = [];
  for (const e of recent) {
    for (const a of e.aspects) aspectSet.add(a);
    if (e.note?.trim()) notes.push(e.note.trim());
  }
  const lines: string[] = [];
  lines.push("以下为该用户近期多次反馈「不满意」时勾选的改进方向，生成本次文献综述时必须遵守（若与摘录事实冲突则以摘录为准）：");
  for (const id of aspectSet) {
    const hint = ASPECT_LLM_HINT[id];
    if (hint) lines.push(`- ${hint}`);
  }
  const uniqNotes = [...new Set(notes)].slice(0, 4);
  for (const n of uniqNotes) {
    lines.push(`- 用户曾补充说明：${n.slice(0, 220)}`);
  }
  return lines.join("\n").slice(0, 1900);
}
