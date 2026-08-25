/**
 * 用户身份 / 用途 → Skill 文本。
 * 检索改写（rewrite）与文献综述（synthesize）在调用 LLM 前会**先拼接**对应 Skill，再执行原有 system 提示。
 */

const LABELS = {
  school_researcher: "科研 / 研究生",
  school_engineer: "工程师 / 校园",
  school_teacher: "教师 / 备课",
  school_student: "本科生 / 课程作业",
  school_writer: "科普 / 科技写作",
  school_patent: "专利 / IP 检索",
  enterprise_intern: "实习生 / 研究生",
  enterprise_tech: "技术 / 研发",
  enterprise_consultant: "顾问 / 顾问",
  enterprise_other: "部门 / 其他",
  enterprise_writer: "撰写 / 专利",
  enterprise_patent: "专利 / IP 检索",
};

const SKILLS = {
  researcher: [
    "## 身份：科研与研究生",
    "检索英文关键词时优先：方法名、数据集、材料/器件、理论模型、benchmark；避免泛化为无关领域。",
    "综述与方案：突出可复现性、与已有工作的差异、实验/仿真设置；引用摘录须保守，未摘录则写「摘录未涉及」。",
    "若问题或摘录涉及**工艺/工序/实验步骤链/样品制备顺序**：输出须含独立「工序流程」式小节（有序先后、输入输出），并与 JSON `steps` 对齐。",
    "摘录含**任何性能/实验数值**时：正文须有「关键数据与指标」表，且 JSON `extractedData` 逐条列出（metric、value、unit、source_ref），不得只写定性描述。",
    "文档草案：适合 Methods / Related work / 实验记录结构；JSON steps 便于实验流水线或文献笔记工具。",
  ].join("\n"),

  engineer: [
    "## 身份：工程研发与企业",
    "检索关键词偏向：工艺参数、标准号、器件型号、可靠性、成本、量产相关术语（中英皆可映射到英文检索）。",
    "综述与方案：强调可落地步骤、输入输出、验收指标、安全与合规；少理论铺陈，多检查清单与工具链（CAD/仿真/测试）。",
    "凡涉及**产线、工位顺序、加工/装配/检测工序、热处理/焊接流程、SOP**：必须输出**工序流程**（编号先后、每步输入/输出/设备/质控点），并与 `steps` 一一对应。",
    "涉及产能、良率、尺寸公差、物性指标等**数字**：必须写入「关键数据与指标」表及 JSON `extractedData`，便于下游系统读取。",
    "文档草案：对齐 SOP、设计评审、测试用例；JSON 中 tools_suggested、actor 要具体。",
  ].join("\n"),

  teacher: [
    "## 身份：教师与备课",
    "检索偏向：教学法、概念定义、教材级解释、演示实验、可视化与常见误区；英文关键词可含 pedagogy, tutorial, survey（综述课用）。",
    "综述与方案：分难度层级、课堂活动建议、可引用作延伸阅读；避免过深假设学生未学内容。",
    "文档草案：教学目标、课前阅读、课堂问题、作业与评分要点。",
  ].join("\n"),

  student: [
    "## 身份：本科生与课程作业",
    "检索偏向：入门综述、经典论文、定义清晰的基础问题；关键词勿过窄以免零结果。",
    "综述与方案：语言直白、步骤少而清、注明「需进一步查证」处；引用只信摘录。",
    "文档草案：类似作业说明：问题陈述、参考资料、时间线。",
  ].join("\n"),

  patent: [
    "## 身份：专利与 IP",
    "检索偏向：技术效果、权利要求用语、分类号、现有技术、侵权/无效相关英文表述。",
    "综述与方案：区分技术事实与法律状态；摘录未涉及时不写法律结论。",
    "文档草案：技术问题、新颖性要点、检索式维护记录式小节。",
  ].join("\n"),

  writer: [
    "## 身份：科普与科技写作",
    "检索偏向：权威综述、官方数据、可视化与比喻可用的来源；关键词兼顾准确与可理解。",
    "综述与方案：少用行话或先定义；标注「适合引用的比喻/数据是否来自摘录」。",
    "文档草案：读者对象、核心信息、事实核查清单。",
  ].join("\n"),
};

// 版本化身份复用对应的基础 Skill；保留旧 id 以兼容历史请求与已保存数据。
Object.assign(SKILLS, {
  school_researcher: SKILLS.researcher,
  school_engineer: SKILLS.engineer,
  school_teacher: SKILLS.teacher,
  school_student: SKILLS.student,
  school_writer: SKILLS.writer,
  school_patent: SKILLS.patent,
  enterprise_intern: SKILLS.researcher,
  enterprise_tech: SKILLS.engineer,
  enterprise_consultant: SKILLS.engineer,
  enterprise_other: SKILLS.teacher,
  enterprise_writer: SKILLS.patent,
  enterprise_patent: SKILLS.patent,
});

/** @param {string} raw */
export function normalizePersonaId(raw) {
  const id = String(raw ?? "")
    .trim()
    .slice(0, 64);
  return SKILLS[id] ? id : "researcher";
}

/** @param {string} personaId */
export function getPersonaSkill(personaId) {
  const id = normalizePersonaId(personaId);
  return SKILLS[id] || SKILLS.researcher;
}

export function listPersonas() {
  return Object.keys(LABELS).map((id) => ({ id, label: LABELS[id] || id }));
}
