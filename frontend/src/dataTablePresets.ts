/** 数据库渠道：预设数据表类型（与后端 dataTableExtract.js 一致） */
export const DATA_TABLE_PRESETS = [
  {
    id: "performance",
    label: "性能指标",
    description: "效率、容量、产率、寿命等性能数据",
  },
  {
    id: "composition",
    label: "组分配方",
    description: "元素比、前驱体、掺杂浓度等",
  },
  {
    id: "process",
    label: "工艺参数",
    description: "温度、压力、时间、气氛等制备条件",
  },
  {
    id: "structure",
    label: "结构形貌",
    description: "粒径、厚度、孔径、比表面积等",
  },
  {
    id: "comparison",
    label: "样品对比",
    description: "不同样品/文献的横向指标对比",
  },
] as const;

export type DataTablePresetId = (typeof DATA_TABLE_PRESETS)[number]["id"];

export type DataTableRow = {
  metric?: string;
  value?: string;
  unit?: string;
  condition?: string;
  source_ref?: string;
  context?: string;
  material?: string;
};

export type GeneratedDataTable = {
  tableType: string;
  title: string;
  rows: DataTableRow[];
  note?: string;
  generatedAt?: number;
};
