export type PointBalance = {
  userId?: string;
  balanceUnits: number;
  availableUnits: number;
  balance: number;
};

export type RechargeProvider = "alipay" | "wechat";

export type RechargeCatalog = {
  package: {
    id: string;
    amountFen: number;
    amountYuan: number;
    points: number;
    pointUnits: number;
  };
  providers: Array<{
    id: RechargeProvider;
    label: string;
    enabled: boolean;
  }>;
};

export type RechargeOrder = {
  id: string;
  orderNo: string;
  provider: RechargeProvider;
  packageId: string;
  amountFen: number;
  amountYuan: number;
  points: number;
  pointUnits: number;
  status: "creating" | "pending" | "paid" | "failed" | "closed";
  codeUrl?: string | null;
  qrCodeDataUrl?: string | null;
  failureCode?: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  paidAt?: number | null;
  billing?: PointBalance;
};

export type Pricing = {
  unitsPerPoint: number;
  characterUnitCost: number;
  chartPointUnitCost: number;
  pdfUnitCost: number;
  [key: string]: number | string | undefined;
};

export type BillingLineItem = {
  type?: string;
  description?: string;
  quantity?: number;
  unitCostUnits?: number;
  costUnits?: number;
  cost?: number;
  [key: string]: unknown;
};

export type BillingReceipt = {
  operationId: string;
  costUnits: number;
  cost: number;
  balanceUnits: number;
  balance: number;
  billingDetails?: {
    characterCount?: number;
    pointCount?: number;
    validPointCount?: number;
    chartPointCount?: number;
    pdfCount?: number;
    deepPaperCount?: number;
    [key: string]: unknown;
  };
  lineItems?: BillingLineItem[];
  [key: string]: unknown;
};

export type Paper = {
  id: string;
  title: string;
  summary: string;
  published: string;
  authors: string[];
  pdfUrl: string;
  absUrl: string;
  /** 服务端计费 PDF 交付的不透明来源 id（字段名兼容后端演进） */
  pdfSourceId?: string;
  sourceId?: string;
  /** 后端归一化 id（SQLite / 融合去重） */
  paper_id?: string;
  /** 专利公开号/申请号（网页渠道专利补充等） */
  patentNumber?: string | null;
  doi?: string | null;
  venue?: string | null;
  year?: number | null;
  source?:
    | "arxiv"
    | "crossref"
    | "local"
    | "mcp_web"
    | "ddg_web"
    | "ddg_patent"
    | "dataify_web"
    | "tavily_web"
    | "openalex"
    | "openalex_patent"
    | "europepmc"
    | "semantic_scholar"
    | "wikipedia_web"
    | "core"
    | "scopus";
  oa_status?: string | null;
  isReferencedByCount?: number | null;
  /** 网页正文抓取状态：fetched 表示已合并较长正文到 summary */
  webFetchNote?: string | null;
  webFetchedAt?: number | null;
  /** 该条摘录关联的数值指标（综述 extractedData + 正文规则抽取） */
  dataPoints?: PaperDataPoint[] | null;
};

export type PaperDataPoint = {
  metric: string;
  value: string;
  unit?: string;
  condition?: string;
  context?: string;
  /** synthesis = 来自综述 JSON；summary = 摘录正文规则抽取 */
  via?: "synthesis" | "summary";
};

/** arXiv 检索字段：与输入区「产品 / 材料 / 综合方案」对应 */
export type ArxivSearchField = "ti" | "abs" | "all";

/** 规格 2：双渠道 */
export type SearchChannel = "database" | "web";

/** 规格 S-2：排序（被引次数无全文 API 时由 Crossref 近似） */
export type PaperSortKey = "relevance" | "submittedDate" | "lastUpdatedDate" | "citations";

/** 语义理解：LLM 解析的用户检索意图（精简字段） */
export type QueryIntent = {
  topic?: string;
  summaryZh?: string;
  materials?: string[];
  properties?: string[];
  searchTerms?: string[];
  /** 自动纠错记录，如「聚脂纤维→聚酯纤维」 */
  typoFixes?: string[];
  correctedQuery?: string;
  note?: string;
};

export type LlmTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
};

export type SearchLlmUsage = {
  slots: Record<string, LlmTokenUsage>;
  total: LlmTokenUsage;
};

export type PerformanceTrace = {
  version: number;
  requestId?: string;
  startedAt: number;
  totalMs: number;
  stages: Array<{
    name: string;
    startMs: number;
    durationMs: number;
    details?: Record<string, string | number | boolean>;
  }>;
};

export type SearchResultMeta = {
  effectiveQuery?: string;
  rewriteNote?: string;
  /** 语义理解结果（材料/性能/检索词等） */
  queryIntent?: QueryIntent | null;
  sourcesUsed?: string[];
  channel?: SearchChannel;
  sort?: PaperSortKey;
  /** 仅专利检索模式（与请求 patentsOnly 一致） */
  patentsOnly?: boolean;
  latencyMs?: number;
  /** 服务端请求级分阶段耗时，便于定位检索、网页抓取和模型调用瓶颈。 */
  performanceTrace?: PerformanceTrace | null;
  /** 基于检索文献摘要的 LLM 综述（Markdown），引用处应含 DOI / arXiv；末尾 JSON 已由服务端剥离 */
  synthesis?: string | null;
  /** 如 synth:no-llm-key、synth:ok，便于排查未生成原因 */
  synthesisNote?: string | null;
  /** 回答因积分耗尽而被服务端截断。 */
  pointsExhausted?: boolean;
  billingMessage?: string;
  /** 从模型输出解析出的可执行方案（JSON 对象），供其它程序直接读接口字段，无需解析 Markdown */
  synthesisPlan?: Record<string, unknown> | null;
  /** 未解析出 plan 时的原因，如 synth_plan:no_json_block、synth_plan:parse_error */
  synthesisPlanNote?: string | null;
  /** 多模型综述元数据；联网流程中 A/B 为作答模型，C 为仲裁模型 */
  synthesisModels?: {
    modelA?: string;
    modelB?: string | null;
    modelC?: string | null;
    mode?: string;
  } | null;
  /** 网页渠道：A/B 仲裁前草稿；modelC 仅为历史三草稿记录兼容字段 */
  webAnswerDrafts?: {
    modelA?: string | null;
    modelB?: string | null;
    modelC?: string | null;
    noteA?: string;
    noteB?: string;
    noteC?: string;
  } | null;
  /** 上游模型实际返回的 token 用量；与按字符计算的站内计费相互独立 */
  llmUsage?: SearchLlmUsage | null;
  /** 本次检索使用的身份 id（与侧栏「身份/用途」一致） */
  persona?: string;
  personaLabel?: string;
  /** 父搜索操作 id（图表/PDF 交付只关联已完成的本人搜索） */
  parentOperationId?: string;
  /** 本次搜索的服务端计费收据 */
  billing?: BillingReceipt | null;
  /** 当前回答内成功交付的 PDF 收据 */
  pdfReceipts?: BillingReceipt[];
  /** Matplotlib 数值图等 */
  paperChart?: {
    mime: string;
    pngBase64: string | null;
    svgBase64?: string | null;
    title: string;
    spec?: Record<string, unknown> | null;
    note?: string;
    billing?: BillingReceipt | null;
  } | null;
  /** 最近一次「生成图表」失败时的说明（成功后会清除） */
  paperChartError?: string | null;
  /** 数据库渠道：按类型生成的结构化数据表 */
  dataTables?: Record<
    string,
    {
      tableType: string;
      title: string;
      rows: Array<{
        metric?: string;
        value?: string;
        unit?: string;
        condition?: string;
        source_ref?: string;
        context?: string;
        material?: string;
      }>;
      note?: string;
      generatedAt?: number;
    }
  >;
  activeDataTableType?: string;
  dataTableError?: string | null;
  /** 工艺流程图 / PPT 素材（检索完成后由后端从综述与 synthesisPlan 生成） */
  artifacts?: {
    flowchart?: {
      mermaid: string;
      steps?: Array<{
        step_no?: number | string;
        action: string;
        inputs?: string;
        outputs?: string;
        note?: string;
      }>;
      recipeLines?: string[];
      svgBase64?: string | null;
      title?: string;
    } | null;
    note?: string;
    stepCount?: number;
  } | null;
  /** 最近一次 PPT / 流程图操作失败说明 */
  artifactError?: string | null;
  /** 深度管线：下载 PDF → MinerU → 三模型关键词 JSON */
  deepMine?: {
    enabled?: boolean;
    note?: string;
    mineruExe?: string;
    models?: string[];
    papers?: Array<{
      title?: string;
      doi?: string | null;
      pdfUrl?: string;
      steps?: string[];
      keywordModels?: Array<{
        ok?: boolean;
        model?: string;
        data?: Record<string, unknown>;
        error?: string;
        rawPreview?: string;
      }>;
      mdPreview?: string;
      errors?: string[];
    }>;
  } | null;
  /** 基于 deepMine 结构化结果的额外中文综合 */
  deepSynthesis?: string | null;
  deepSynthesisNote?: string | null;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  papers?: Paper[];
  error?: boolean;
  arxivField?: ArxivSearchField;
  /** 与规格 2/4/6 对齐的检索元信息 */
  meta?: SearchResultMeta;
};

export type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

export type ChatSessionsSyncState = {
  revision: number;
  schemaVersion: number;
  updatedAt: number;
};

/** 已通过 /api/v1/extract 解析的上传片段（仅存于前端会话发送前） */
export type UploadedAttachment = {
  id: string;
  name: string;
  text: string;
  chars: number;
};
