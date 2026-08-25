import type { AppEdition } from "./edition";
import { getAppEdition } from "./edition";

const STORAGE_KEY = "paper-query-persona-v1";
const PERSONA_VERSION = "v3";

export type PersonaOption = { id: string; label: string };

export const SCHOOL_PERSONA_LIST: PersonaOption[] = [
  { id: "school_researcher", label: "科研 / 研究生" },
  { id: "school_engineer", label: "工程师 / 校园" },
  { id: "school_teacher", label: "教师 / 备课" },
  { id: "school_student", label: "本科生 / 课程作业" },
  { id: "school_writer", label: "科普 / 科技写作" },
  { id: "school_patent", label: "专利 / IP 检索" },
];

export const ENTERPRISE_PERSONA_LIST: PersonaOption[] = [
  { id: "enterprise_intern", label: "实习生 / 研究生" },
  { id: "enterprise_tech", label: "技术 / 研发" },
  { id: "enterprise_consultant", label: "顾问 / 顾问" },
  { id: "enterprise_other", label: "部门 / 其他" },
  { id: "enterprise_writer", label: "撰写 / 专利" },
  { id: "enterprise_patent", label: "专利 / IP 检索" },
];

/** 与后端 personaSkills.js 中的版本化 id 保持一致。 */
export const DEFAULT_PERSONA_LIST = SCHOOL_PERSONA_LIST;

const LEGACY_TO_SCHOOL: Record<string, string> = {
  researcher: "school_researcher",
  engineer: "school_engineer",
  teacher: "school_teacher",
  student: "school_student",
  writer: "school_writer",
  patent: "school_patent",
};

function listForEdition(edition: AppEdition): PersonaOption[] {
  return edition === "enterprise" ? ENTERPRISE_PERSONA_LIST : SCHOOL_PERSONA_LIST;
}

export function getPersonaListForEdition(edition: AppEdition): PersonaOption[] {
  return listForEdition(edition);
}

const ALLOWED = new Set([
  ...SCHOOL_PERSONA_LIST.map((p) => p.id),
  ...ENTERPRISE_PERSONA_LIST.map((p) => p.id),
  ...Object.keys(LEGACY_TO_SCHOOL),
]);

/** 检查并清理过期的 localStorage 数据。 */
function cleanupOldData(): void {
  try {
    const savedVersion = localStorage.getItem("paper-query-persona-version");
    if (savedVersion !== PERSONA_VERSION) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem("paper-query-persona-version", PERSONA_VERSION);
    }
  } catch {
    /* ignore */
  }
}

cleanupOldData();

export function getPersonaId(edition: AppEdition = getAppEdition()): string {
  const options = listForEdition(edition);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const migrated = raw ? LEGACY_TO_SCHOOL[raw] ?? raw : "";
    if (ALLOWED.has(migrated) && options.some((p) => p.id === migrated)) return migrated;
  } catch {
    /* ignore */
  }
  return options[0]?.id ?? "school_researcher";
}

export function setPersonaId(id: string, edition: AppEdition = getAppEdition()): void {
  const options = listForEdition(edition);
  const next = options.some((p) => p.id === id) ? id : options[0]?.id ?? "school_researcher";
  try {
    localStorage.setItem(STORAGE_KEY, next);
    localStorage.setItem("paper-query-persona-version", PERSONA_VERSION);
  } catch {
    /* ignore */
  }
}

export async function fetchPersonaList(edition: AppEdition = getAppEdition()): Promise<PersonaOption[]> {
  return listForEdition(edition);
}
