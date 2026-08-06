const STORAGE_KEY = "paper-query-persona-v1";
const PERSONA_VERSION = "v2"; // 版本号，更新时修改

/** 与 `backend/personaSkills.js` 中 id 保持一致；供离线或接口失败时展示 */
export const DEFAULT_PERSONA_LIST: { id: string; label: string }[] = [
  { id: "researcher", label: "科研 / 研究生" },
  { id: "engineer", label: "工程研发 / 企业" },
  { id: "teacher", label: "教师 / 备课" },
  { id: "student", label: "本科生 / 课程作业" },
  { id: "patent", label: "专利 / IP 检索" },
  { id: "writer", label: "科普 / 科技写作" },
];

const ALLOWED = new Set(DEFAULT_PERSONA_LIST.map((p) => p.id));

/** 检查并清理过期的localStorage数据 */
function cleanupOldData(): void {
  try {
    const savedVersion = localStorage.getItem("paper-query-persona-version");
    if (savedVersion !== PERSONA_VERSION) {
      // 版本不一致，清除旧数据
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem("paper-query-persona-version", PERSONA_VERSION);
      console.log("[persona] 已清除旧版本身份数据");
    }
  } catch {
    /* ignore */
  }
}

// 初始化时清理旧数据
cleanupOldData();

export function getPersonaId(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && ALLOWED.has(v)) return v;
  } catch {
    /* ignore */
  }
  return "researcher";
}

export function setPersonaId(id: string): void {
  const next = ALLOWED.has(id) ? id : "researcher";
  try {
    localStorage.setItem(STORAGE_KEY, next);
    localStorage.setItem("paper-query-persona-version", PERSONA_VERSION);
  } catch {
    /* ignore */
  }
}

export async function fetchPersonaList(): Promise<{ id: string; label: string }[]> {
  // 优先使用本地列表，避免后端缓存问题
  return DEFAULT_PERSONA_LIST;
}
