import type {
  ArxivSearchField,
  BillingLineItem,
  BillingReceipt,
  ChatSession,
  Paper,
  PaperSortKey,
  PointBalance,
  Pricing,
  RechargeCatalog,
  RechargeOrder,
  RechargeProvider,
  SearchChannel,
  SearchResultMeta,
} from "./types";
import { getLlmChatCompletionsUrl, getOpenAiKey, getOpenAiModel } from "./openaiKey";
import { getPersonaId } from "./persona";
import { getAuthToken, getEffectiveUserId } from "./authSession";
import { getOutputAvoidanceForRequest } from "./outputPreferences";
import { appEditionHeader } from "./edition";

/** 带超时的 fetch（检索/综述等长请求） */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 900_000;
  const { timeoutMs: _drop, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `请求超时（已等待 ${Math.round(timeoutMs / 1000)} 秒）。联网检索与综合回答可能需 1～3 分钟，请稍后重试或缩短问题。`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly balance?: PointBalance;

  constructor(message: string, opts: { status: number; code?: string; details?: unknown; balance?: PointBalance }) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.balance = opts.balance;
  }
}

export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePointBalance(value: unknown): PointBalance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const unitsPerPoint = finiteNumber(raw.unitsPerPoint, 20) || 20;
  const rawBalanceUnits = raw.balanceUnits ?? raw.availableUnits;
  const rawBalance = raw.balance;
  const hasBalanceUnits = rawBalanceUnits != null && String(rawBalanceUnits).trim() !== "";
  const hasBalance = rawBalance != null && String(rawBalance).trim() !== "";
  // Error details can be an arbitrary object. Missing balance fields must not
  // be interpreted as an explicit zero balance.
  if (!hasBalanceUnits && !hasBalance) return undefined;
  const balanceUnits = hasBalanceUnits
    ? finiteNumber(rawBalanceUnits)
    : Math.round(finiteNumber(rawBalance) * unitsPerPoint);
  const availableUnits = finiteNumber(raw.availableUnits, balanceUnits);
  const balance = hasBalance ? finiteNumber(rawBalance) : balanceUnits / unitsPerPoint;
  return {
    userId: raw.userId != null ? String(raw.userId) : undefined,
    balanceUnits,
    availableUnits,
    balance,
  };
}

function parsePricing(value: unknown): Pricing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const unitsPerPoint = finiteNumber(raw.unitsPerPoint ?? raw.units_per_point, 20) || 20;
  return {
    ...raw,
    unitsPerPoint,
    characterUnitCost: finiteNumber(raw.characterUnitCost ?? raw.charUnitCost ?? raw.characterUnits, 1),
    chartPointUnitCost: finiteNumber(raw.chartPointUnitCost ?? raw.chartUnitCost ?? raw.chartPointUnits, 2),
    pdfUnitCost: finiteNumber(raw.pdfUnitCost ?? raw.pdfUnits, 20),
  } as Pricing;
}

function parseBillingReceipt(value: unknown): BillingReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const operationId = raw.operationId ?? raw.operation_id;
  if (operationId == null || String(operationId).trim() === "") return undefined;
  const rawBalanceUnits = raw.balanceUnits ?? raw.availableUnits;
  const rawBalance = raw.balance;
  const hasBalanceUnits = rawBalanceUnits != null && String(rawBalanceUnits).trim() !== "";
  const hasBalance = rawBalance != null && String(rawBalance).trim() !== "";
  // A PDF response may include an operation id without balance headers. Do not
  // parse that missing balance as zero and temporarily overwrite the UI.
  if (!hasBalanceUnits && !hasBalance) return undefined;
  const balanceUnits = hasBalanceUnits
    ? finiteNumber(rawBalanceUnits)
    : Math.round(finiteNumber(rawBalance) * 20);
  const costUnits = finiteNumber(raw.costUnits ?? raw.units);
  return {
    ...raw,
    operationId: String(operationId),
    costUnits,
    cost: finiteNumber(raw.cost, costUnits / 20),
    balanceUnits,
    balance: hasBalance ? finiteNumber(rawBalance) : balanceUnits / 20,
    billingDetails:
      raw.billingDetails && typeof raw.billingDetails === "object" && !Array.isArray(raw.billingDetails)
        ? (raw.billingDetails as BillingReceipt["billingDetails"])
        : undefined,
    lineItems: Array.isArray(raw.lineItems) ? (raw.lineItems as BillingLineItem[]) : undefined,
  };
}

function errorBalance(data: Record<string, unknown>): PointBalance | undefined {
  return parsePointBalance(data.billing ?? data.balance ?? data.details);
}

function apiErrorFrom(status: number, data: Record<string, unknown>, fallback: string): ApiError {
  const details = data.details;
  const message = String(data.error ?? data.message ?? fallback);
  return new ApiError(message, {
    status,
    code: data.code != null ? String(data.code) : undefined,
    details,
    balance: errorBalance(data),
  });
}

export async function fetchPointBalance(): Promise<{ billing: PointBalance; pricing?: Pricing }> {
  const res = await fetch("/api/v1/billing/balance", { headers: headersJson() });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new ApiError(`积分余额响应不是合法 JSON（HTTP ${res.status}）`, { status: res.status });
  }
  if (!res.ok) throw apiErrorFrom(res.status, data, `获取积分余额失败（${res.status}）`);
  const billing = parsePointBalance(data.billing ?? data.balance ?? data);
  if (!billing) throw new ApiError("积分余额响应不完整", { status: res.status });
  return { billing, pricing: parsePricing(data.pricing) };
}

function parseRechargeOrder(value: unknown): RechargeOrder | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id ?? "").trim();
  const orderNo = String(raw.orderNo ?? "").trim();
  const provider = String(raw.provider ?? "") as RechargeProvider;
  const status = String(raw.status ?? "") as RechargeOrder["status"];
  if (!id || !orderNo || !["alipay", "wechat"].includes(provider)) return undefined;
  if (!["creating", "pending", "paid", "failed", "closed"].includes(status)) return undefined;
  return {
    id,
    orderNo,
    provider,
    packageId: String(raw.packageId ?? ""),
    amountFen: finiteNumber(raw.amountFen),
    amountYuan: finiteNumber(raw.amountYuan, finiteNumber(raw.amountFen) / 100),
    points: finiteNumber(raw.points),
    pointUnits: finiteNumber(raw.pointUnits),
    status,
    codeUrl: raw.codeUrl == null ? null : String(raw.codeUrl),
    qrCodeDataUrl: raw.qrCodeDataUrl == null ? null : String(raw.qrCodeDataUrl),
    failureCode: raw.failureCode == null ? null : String(raw.failureCode),
    createdAt: finiteNumber(raw.createdAt),
    updatedAt: finiteNumber(raw.updatedAt),
    expiresAt: finiteNumber(raw.expiresAt),
    paidAt: raw.paidAt == null ? null : finiteNumber(raw.paidAt),
    billing: parsePointBalance(raw.billing),
  };
}

export async function fetchRechargeCatalog(): Promise<RechargeCatalog> {
  const res = await fetch("/api/v1/billing/recharge/catalog", { headers: headersJson() });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw apiErrorFrom(res.status, data, `获取充值配置失败（${res.status}）`);
  const pack = data.package as Record<string, unknown> | undefined;
  const providers = Array.isArray(data.providers) ? data.providers : [];
  if (!pack || !String(pack.id ?? "") || !providers.length) {
    throw new ApiError("充值配置响应不完整", { status: res.status });
  }
  return {
    package: {
      id: String(pack.id),
      amountFen: finiteNumber(pack.amountFen),
      amountYuan: finiteNumber(pack.amountYuan, finiteNumber(pack.amountFen) / 100),
      points: finiteNumber(pack.points),
      pointUnits: finiteNumber(pack.pointUnits),
    },
    providers: providers
      .map((item) => item as Record<string, unknown>)
      .filter((item) => item.id === "alipay" || item.id === "wechat")
      .map((item) => ({
        id: item.id as RechargeProvider,
        label: String(item.label ?? item.id),
        enabled: item.enabled === true,
      })),
  };
}

export async function createRechargeOrder(provider: RechargeProvider): Promise<RechargeOrder> {
  const res = await fetch("/api/v1/billing/recharge/orders", {
    method: "POST",
    headers: headersJson({ "Idempotency-Key": createIdempotencyKey() }),
    body: JSON.stringify({ provider }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw apiErrorFrom(res.status, data, `创建充值订单失败（${res.status}）`);
  const order = parseRechargeOrder(data.order);
  if (!order) throw new ApiError("充值订单响应不完整", { status: res.status });
  return order;
}

export async function fetchRechargeOrder(orderId: string): Promise<RechargeOrder> {
  const res = await fetch(`/api/v1/billing/recharge/orders/${encodeURIComponent(orderId)}`, { headers: headersJson() });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw apiErrorFrom(res.status, data, `查询充值订单失败（${res.status}）`);
  const order = parseRechargeOrder(data.order);
  if (!order) throw new ApiError("充值订单响应不完整", { status: res.status });
  return order;
}

export async function fetchUserSkillFavoriteKeywords(): Promise<string[] | undefined> {
  const t = getAuthToken();
  if (!t) return undefined;
  try {
    const res = await fetch("/api/v1/user/skill", {
      headers: {
        Authorization: `Bearer ${t}`,
        "X-User-Id": getEffectiveUserId(),
      },
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { favoriteKeywords?: unknown };
    const fk = j.favoriteKeywords;
    if (!Array.isArray(fk)) return undefined;
    return fk.map((x) => String(x).trim()).filter(Boolean).slice(0, 24);
  } catch {
    return undefined;
  }
}

type SearchResponse = {
  papers: Paper[];
  effectiveQuery?: string;
  rewriteNote?: string;
  queryIntent?: SearchResultMeta["queryIntent"];
  sourcesUsed?: string[];
  channel?: SearchChannel;
  sort?: PaperSortKey;
  latencyMs?: number;
  performanceTrace?: SearchResultMeta["performanceTrace"];
  field?: ArxivSearchField;
  error?: string;
  synthesis?: string | null;
  synthesisNote?: string | null;
  synthesisPlan?: Record<string, unknown> | null;
  synthesisPlanNote?: string | null;
  /** 双模型 / 三密钥综述：modelA / modelB / modelC / mode（single | dual_consensus | dual_partial | tri_arbitration | tri_partial） */
  synthesisModels?: {
    modelA?: string;
    modelB?: string | null;
    modelC?: string | null;
    mode?: string;
  } | null;
  webAnswerDrafts?: SearchResultMeta["webAnswerDrafts"];
  llmUsage?: SearchResultMeta["llmUsage"];
  persona?: string;
  personaLabel?: string;
  deepMine?: SearchResultMeta["deepMine"];
  deepSynthesis?: string | null;
  deepSynthesisNote?: string | null;
  artifacts?: SearchResultMeta["artifacts"];
  /** 与请求体 patentsOnly 一致；仅专利检索时后端为 true */
  patentsOnly?: boolean;
  billing?: BillingReceipt | null;
  billingReceipt?: BillingReceipt | null;
  parentOperationId?: string;
};

function headersJson(extra?: Record<string, string>): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-Id": getEffectiveUserId(),
    ...appEditionHeader(),
    ...extra,
  };
  const t = getAuthToken();
  if (t) h.Authorization = `Bearer ${t}`;
  const k = getOpenAiKey();
  if (k) h["X-OpenAI-Key"] = k;
  const m = getOpenAiModel();
  if (m) h["X-OpenAI-Model"] = m;
  h["X-Persona"] = getPersonaId();
  const chatUrl = getLlmChatCompletionsUrl();
  if (chatUrl) h["X-Llm-Chat-Url"] = chatUrl.slice(0, 2048);
  return h;
}

/** 规格 `/v1/search` 主检索 */
export async function searchPapersV1(
  query: string,
  opts: {
    max?: number;
    field?: ArxivSearchField;
    channel?: SearchChannel;
    sort?: PaperSortKey;
    useLlmRewrite?: boolean;
    /** 由 /api/v1/extract 得到的正文，服务端与检索词合并参与检索与重写 */
    attachmentContext?: string;
    /** 上传文件名（展示用，附件优先合成时写入 prompt） */
    attachmentFilename?: string;
    /** 本对话内上一轮之前的上文（不含其它会话）；与 query 分开发送，新对话应为空 */
    conversationContext?: string;
    /** 默认 true：检索后调用 LLM 生成带 DOI 标注的文献综述 */
    includeSynthesis?: boolean;
    /** 默认 true：为 false 时不外呼专利与全网网页（DDG/Dataify/MCP）；其它检索不变 */
    useMcpWeb?: boolean;
    /** 为 true 时仅返回专利条目（OpenAlex 专利 + 专利网页），并尽量补全 patentNumber；默认不生成综述除非 includeSynthesis 显式为 true */
    patentsOnly?: boolean;
    /** 深度：下载 PDF（默认全部返回篇数，可用 maxPapers 限制）→ MinerU → 三模型各抽关键词 → deepSynthesis */
    deepMine?: boolean | { enabled?: boolean; maxPapers?: number; maxPdfMb?: number };
    /** 为 false 时不附加本机「不满意」偏好（默认 true） */
    attachOutputAvoidance?: boolean;
    /** 与问题一起收紧文献相关性；不传且已登录时会尝试从 /api/v1/user/skill 读取 favoriteKeywords */
    preferenceKeywords?: string[];
    /** 同一次用户动作及其重试必须复用 */
    idempotencyKey?: string;
  } = {},
): Promise<SearchResponse & SearchResultMeta> {
  const dm = opts.deepMine;
  const deepBody =
    dm === true
      ? { enabled: true, maxPdfMb: 20 }
      : dm && typeof dm === "object" && dm.enabled !== false
        ? { enabled: true, maxPdfMb: 20, ...dm }
        : undefined;
  const outputAvoidance =
    opts.attachOutputAvoidance === false ? "" : getOutputAvoidanceForRequest().trim();
  let prefKw = opts.preferenceKeywords;
  if (prefKw === undefined) {
    prefKw = await fetchUserSkillFavoriteKeywords();
  }
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();
  const res = await fetchWithTimeout("/api/v1/search", {
    method: "POST",
    headers: headersJson({ "Idempotency-Key": idempotencyKey }),
    timeoutMs: 900_000,
    body: JSON.stringify({
      query,
      ...(opts.max != null && Number(opts.max) > 0 ? { max: opts.max } : { max: opts.channel === "database" ? 100 : 60 }),
      field: opts.field ?? "all",
      channel: opts.channel ?? "web",
      sort: opts.sort ?? "relevance",
      useLlmRewrite: opts.useLlmRewrite !== false,
      attachmentContext: opts.attachmentContext?.slice(0, 200_000),
      attachmentFilename: opts.attachmentFilename?.slice(0, 512),
      conversationContext: opts.conversationContext?.slice(0, 12_000),
      includeSynthesis: opts.patentsOnly
        ? opts.includeSynthesis === true
        : opts.includeSynthesis !== false,
      useMcpWeb: opts.useMcpWeb !== false,
      ...(opts.patentsOnly ? { patentsOnly: true } : {}),
      ...(deepBody ? { deepMine: deepBody } : {}),
      ...(outputAvoidance ? { outputAvoidance } : {}),
      ...(prefKw?.length ? { preferenceKeywords: prefKw } : {}),
    }),
  });
  const text = await res.text();
  let data: SearchResponse & { error?: string };
  try {
    data = JSON.parse(text) as SearchResponse & { error?: string };
  } catch {
    const htmlish = text.trimStart().startsWith("<");
    if (htmlish) {
      throw new Error(
        "检索接口返回了网页而不是 JSON，通常是未启动后端或未走 API 代理。请在项目根目录运行「npm run dev」（同时起前端与 8787 API），或在使用「预览」时先执行「npm run dev:server」再执行「npm run preview」。",
      );
    }
    const hint =
      res.status === 500 && !text.trim()
        ? "（后端可能崩溃或代理超时：请确认 8787 上 node backend/index.js 在跑，并查看该终端报错）"
        : "";
    throw new Error(`检索响应不是合法 JSON（HTTP ${res.status}）${hint}`);
  }
  if (!res.ok) {
    throw apiErrorFrom(res.status, data as Record<string, unknown>, `请求失败 (${res.status})`);
  }
  data.billing = parseBillingReceipt(data.billing ?? data.billingReceipt) ?? null;
  data.parentOperationId = String(data.parentOperationId ?? data.billing?.operationId ?? "") || undefined;
  return data as SearchResponse & SearchResultMeta;
}

// ── 流式搜索 SSE 接口 ────────────────────────────────────────────
// 对应后端 POST /api/v1/search/stream
// 事件序列：papers → synthesis_token（多次）→ done | error

export type StreamSearchEvent =
  | { type: "papers"; papers: Paper[]; effectiveQuery?: string; rewriteNote?: string; queryIntent?: SearchResultMeta["queryIntent"]; sourcesUsed?: string[]; channel?: SearchChannel; sort?: PaperSortKey; field?: string; patentsOnly?: boolean; latencySearch?: number; persona?: string; personaLabel?: string; parentOperationId?: string }
  | { type: "synthesis_token"; token: string }
  | { type: "synthesis_replace"; synthesis: string }
  | { type: "points_exhausted"; message: string }
  | { type: "done"; synthesis?: string | null; synthesisNote?: string | null; pointsExhausted?: boolean; billingMessage?: string; synthesisPlan?: Record<string, unknown> | null; synthesisPlanNote?: string | null; synthesisModels?: SearchResultMeta["synthesisModels"]; webAnswerDrafts?: SearchResultMeta["webAnswerDrafts"]; llmUsage?: SearchResultMeta["llmUsage"]; performanceTrace?: SearchResultMeta["performanceTrace"]; latencyMs?: number; rewriteNote?: string; sourcesUsed?: string[]; parentOperationId?: string; billingReceipt?: BillingReceipt | null; deepMine?: SearchResultMeta["deepMine"]; deepSynthesis?: string | null; deepSynthesisNote?: string | null; replayed?: boolean }
  | { type: "error"; error: string };

/**
 * 流式搜索+综述：返回 AsyncGenerator，逐帧 yield 事件。
 * 调用方应 for-await-of 消费，收到 "papers" 帧即可显示文献，
 * 收到 "synthesis_token" 逐字追加综述，收到 "done" 完成。
 */
export async function* searchPapersV1Stream(
  query: string,
  opts: Parameters<typeof searchPapersV1>[1] & { signal?: AbortSignal } = {},
): AsyncGenerator<StreamSearchEvent> {
  const dm = opts.deepMine;
  const deepBody =
    dm === true
      ? { enabled: true, maxPdfMb: 20 }
      : dm && typeof dm === "object" && (dm as { enabled?: boolean }).enabled !== false
        ? { enabled: true, maxPdfMb: 20, ...(dm as object) }
        : undefined;
  const outputAvoidance =
    opts.attachOutputAvoidance === false ? "" : getOutputAvoidanceForRequest().trim();
  let prefKw = opts.preferenceKeywords;
  if (prefKw === undefined) {
    prefKw = await fetchUserSkillFavoriteKeywords();
  }
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();

  const controller = new AbortController();
  const externalSignal = opts.signal;
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });

  // 900s 超时（与非流式一致）
  const timeoutId = window.setTimeout(() => controller.abort(), 900_000);

  try {
    const res = await fetch("/api/v1/search/stream", {
      method: "POST",
      headers: headersJson({ "Idempotency-Key": idempotencyKey }),
      signal: controller.signal,
      body: JSON.stringify({
        query,
        ...(opts.max != null && Number(opts.max) > 0 ? { max: opts.max } : { max: opts.channel === "database" ? 100 : 60 }),
        field: opts.field ?? "all",
        channel: opts.channel ?? "web",
        sort: opts.sort ?? "relevance",
        useLlmRewrite: opts.useLlmRewrite !== false,
        attachmentContext: opts.attachmentContext?.slice(0, 200_000),
        attachmentFilename: opts.attachmentFilename?.slice(0, 512),
        conversationContext: opts.conversationContext?.slice(0, 12_000),
        includeSynthesis: opts.patentsOnly
          ? opts.includeSynthesis === true
          : opts.includeSynthesis !== false,
        useMcpWeb: opts.useMcpWeb !== false,
        ...(opts.patentsOnly ? { patentsOnly: true } : {}),
        ...(deepBody ? { deepMine: deepBody } : {}),
        ...(outputAvoidance ? { outputAvoidance } : {}),
        ...(prefKw?.length ? { preferenceKeywords: prefKw } : {}),
      }),
    });

    if (!res.ok) {
      let errMsg = `请求失败 (${res.status})`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) errMsg = j.error;
      } catch { /* ignore */ }
      yield { type: "error", error: errMsg };
      return;
    }

    if (!res.body) {
      yield { type: "error", error: "浏览器不支持流式响应（response.body 为空）" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed) {
          // 空行 = 帧结束（SSE 规范），但此处 event/data 已逐行处理，跳过
          eventName = "";
          continue;
        }
        if (trimmed.startsWith("event: ")) {
          eventName = trimmed.slice(7).trim();
        } else if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6);
          try {
            const obj = JSON.parse(payload) as Record<string, unknown>;
            if (eventName === "papers") {
              yield { type: "papers", ...(obj as Omit<StreamSearchEvent & { type: "papers" }, "type">) };
            } else if (eventName === "synthesis_token") {
              yield { type: "synthesis_token", token: String(obj.token ?? "") };
            } else if (eventName === "synthesis_replace") {
              yield { type: "synthesis_replace", synthesis: String(obj.synthesis ?? "") };
            } else if (eventName === "points_exhausted") {
              yield { type: "points_exhausted", message: String(obj.message ?? "积分已用完，请充值后继续回答。") };
            } else if (eventName === "done") {
              const doneEvent = obj as Omit<StreamSearchEvent & { type: "done" }, "type">;
              const billingReceipt = parseBillingReceipt(obj.billingReceipt ?? obj.billing) ?? null;
              yield {
                type: "done",
                ...doneEvent,
                billingReceipt,
                parentOperationId:
                  String(obj.parentOperationId ?? billingReceipt?.operationId ?? "") || undefined,
              };
              await reader.cancel().catch(() => undefined);
              return;
            } else if (eventName === "error") {
              yield { type: "error", error: String(obj.error ?? "未知错误") };
              await reader.cancel().catch(() => undefined);
              return;
            }
          } catch { /* malformed JSON line, skip */ }
          eventName = "";
        }
      }
    }
    yield { type: "error", error: "与后端的连接已中断，回答未完成，请确认服务已启动后重新发送。" };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      yield { type: "error", error: "请求已取消或超时" };
    } else {
      yield { type: "error", error: e instanceof Error ? e.message : "网络错误" };
    }
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export async function submitFeedback(payload: {
  messageId: string;
  value: 1 | -1;
  channel?: SearchChannel;
}): Promise<void> {
  const res = await fetch("/api/v1/feedback", {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      ...payload,
      userId: getEffectiveUserId(),
    }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `反馈失败 (${res.status})`);
  }
}

const EXTRACT_MAX_MB = 100;
const EXTRACT_MAX_BYTES = EXTRACT_MAX_MB * 1024 * 1024;
const EXTRACT_ALLOWED_EXT = /\.(pdf|md|markdown|txt|text|docx?|docm|pptx|ppsx)$/i;

function isExtractAllowedFile(file: File): boolean {
  const name = file.name || "";
  if (EXTRACT_ALLOWED_EXT.test(name)) return true;
  const t = (file.type || "").toLowerCase();
  return (
    t === "application/pdf" ||
    t === "application/msword" ||
    t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    t === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    t === "text/plain" ||
    t === "text/markdown"
  );
}

/** 上传并解析 pdf / pptx / markdown / txt / doc / docx（multipart，字段名 file） */
export async function extractUploadedDocument(
  file: File,
): Promise<{ filename: string; text: string; charCount: number }> {
  const name = file.name || "file";
  if (!isExtractAllowedFile(file)) {
    throw new Error(
      `不支持「${name}」：请使用 PDF、PPTX、Markdown、TXT、Word（.doc / .docx），单文件 ≤${EXTRACT_MAX_MB}MB`,
    );
  }
  if (file.size > EXTRACT_MAX_BYTES) {
    throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），单文件上限 ${EXTRACT_MAX_MB}MB`);
  }
  if (file.size === 0) {
    throw new Error("空文件，请选择有内容的文件");
  }

  const fd = new FormData();
  fd.append("file", file);
  let res: Response;
  try {
    res = await fetch("/api/v1/extract", {
      method: "POST",
      headers: {
        "X-User-Id": getEffectiveUserId(),
        ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      },
      body: fd,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `无法连接上传接口（${msg}）。请用 npm run dev 打开页面（5175 会代理到 8787），并确认后端在运行。`,
    );
  }

  const text = await res.text();
  let data: { filename?: string; text?: string; charCount?: number; error?: string };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    const htmlish = text.trimStart().startsWith("<");
    if (htmlish) {
      throw new Error(
        "上传接口返回了网页而不是 JSON。请用 npm run dev 同时启动前后端，不要只打开静态 dist 页面。",
      );
    }
    throw new Error(`上传响应不是合法 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    throw new Error(data.error || `解析失败 (${res.status})`);
  }
  return {
    filename: data.filename || name,
    text: data.text || "",
    charCount: data.charCount ?? (data.text?.length ?? 0),
  };
}

export type FulfillPdfResult = {
  blob: Blob;
  receipt?: BillingReceipt;
  filename?: string;
};

function decodeReceiptHeader(raw: string | null): BillingReceipt | undefined {
  if (!raw) return undefined;
  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    /* not URI encoded */
  }
  try {
    candidates.push(atob(raw.replace(/^base64:/i, "")));
  } catch {
    /* not base64 */
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const receipt = parseBillingReceipt(parsed);
      if (receipt) return receipt;
    } catch {
      /* try next representation */
    }
  }
  return undefined;
}

function receiptFromHeaders(headers: Headers): BillingReceipt | undefined {
  for (const name of ["Billing-Receipt", "X-Billing-Receipt", "X-Points-Receipt"]) {
    const receipt = decodeReceiptHeader(headers.get(name));
    if (receipt) return receipt;
  }
  const operationId = headers.get("Billing-Operation-Id") ?? headers.get("X-Billing-Operation-Id");
  if (!operationId) return undefined;
  const balanceUnits = headers.get("Billing-Balance-Units") ?? headers.get("X-Billing-Balance-Units");
  const balance = headers.get("Billing-Balance") ?? headers.get("X-Billing-Balance");
  if (!balanceUnits?.trim() && !balance?.trim()) return undefined;
  return parseBillingReceipt({
    operationId,
    costUnits: headers.get("Billing-Cost-Units") ?? headers.get("X-Billing-Cost-Units"),
    cost: headers.get("Billing-Cost") ?? headers.get("X-Billing-Cost"),
    balanceUnits,
    balance,
    billingDetails: { pdfCount: 1 },
  });
}

/** 经鉴权的 PDF 获取；成功后才由服务端结算。 */
export async function fulfillPdf(opts: {
  parentOperationId: string;
  paperId?: string;
  paperIndex?: number;
  sourceId?: string;
  idempotencyKey?: string;
}): Promise<FulfillPdfResult> {
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();
  const res = await fetch("/api/v1/pdfs/fulfill", {
    method: "POST",
    headers: headersJson({ "Idempotency-Key": idempotencyKey }),
    body: JSON.stringify({
      parentOperationId: opts.parentOperationId,
      ...(opts.sourceId ? { sourceId: opts.sourceId, pdfSourceId: opts.sourceId } : {}),
      ...(opts.paperId ? { paperId: opts.paperId } : {}),
      ...(opts.paperIndex != null ? { paperIndex: opts.paperIndex } : {}),
    }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let data: Record<string, unknown> = {};
    if (contentType.includes("json")) {
      data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    }
    throw apiErrorFrom(res.status, data, `PDF 获取失败（${res.status}）`);
  }
  if (contentType.includes("json")) {
    const data = (await res.json()) as Record<string, unknown>;
    const encoded = data.pdfBase64 ?? data.base64 ?? data.data;
    if (typeof encoded !== "string" || !encoded) {
      throw apiErrorFrom(res.status, data, "PDF 响应未包含文件");
    }
    const bytes = Uint8Array.from(atob(encoded.replace(/^data:application\/pdf;base64,/i, "")), (c) => c.charCodeAt(0));
    return {
      blob: new Blob([bytes], { type: "application/pdf" }),
      receipt: parseBillingReceipt(data.billing ?? data.receipt) ?? receiptFromHeaders(res.headers),
      filename: data.filename != null ? String(data.filename) : undefined,
    };
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
  return {
    blob: await res.blob(),
    receipt: receiptFromHeaders(res.headers),
    filename: filenameMatch ? decodeURIComponent(filenameMatch[1].replace(/^"|"$/g, "")) : undefined,
  };
}

export type PaperChartApiResult = {
  mime: string;
  pngBase64: string | null;
  svgBase64: string | null;
  title: string;
  spec: Record<string, unknown>;
  matplotlibStderr?: string;
  note?: string;
  billing?: BillingReceipt;
};

function slimPaperForChartApi(p: Paper) {
  const id = String(p.id ?? "");
  const arx = id.replace(/^arxiv:/i, "").trim();
  return {
    id,
    paper_id: p.paper_id,
    title: p.title,
    summary: p.summary,
    abstract: p.summary,
    doi: p.doi ?? null,
    year: p.year ?? null,
    arxiv_id: /^arxiv:/i.test(id) ? arx : undefined,
    source: p.source ?? null,
    absUrl: p.absUrl ?? null,
    patentNumber: p.patentNumber ?? null,
  };
}



/** 从服务端加载聊天会话（登录用户，后端持久化） */
export async function fetchChatSessionsFromServer(): Promise<{
  sessions: ChatSession[];
  updatedAt: number;
  revision: number;
  schemaVersion: number;
} | null> {
  const res = await fetch("/api/v1/chat/sessions", { headers: headersJson() });
  if (res.status === 401) return null;
  if (!res.ok) {
    console.warn("[api] fetchChatSessions failed", res.status);
    return null;
  }
  const data = (await res.json()) as {
    sessions?: ChatSession[];
    updatedAt?: number;
    revision?: number;
    schema_version?: number;
  };
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    updatedAt: Number(data.updatedAt) || 0,
    revision: Number(data.revision) || 0,
    schemaVersion: Number(data.schema_version) || 1,
  };
}

/** 保存聊天会话到服务端 */
export async function saveChatSessionsToServer(
  sessions: ChatSession[],
  updatedAt?: number,
  baseRevision?: number | null,
): Promise<{
  ok: boolean;
  revision?: number;
  updatedAt?: number;
  conflict?: boolean;
  sessions?: ChatSession[];
}> {
  const res = await fetch("/api/v1/chat/sessions", {
    method: "PUT",
    headers: headersJson(),
    body: JSON.stringify({
      sessions,
      updatedAt: updatedAt ?? Date.now(),
      ...(baseRevision != null ? { baseRevision } : {}),
    }),
  });
  if (res.status === 401) return { ok: false };
  if (res.status === 409) {
    try {
      const j = (await res.json()) as {
        code?: string;
        revision?: number;
        sessions?: ChatSession[];
        updatedAt?: number;
      };
      return {
        ok: false,
        conflict: true,
        revision: Number(j.revision) || 0,
        sessions: Array.isArray(j.sessions) ? j.sessions : [],
        updatedAt: Number(j.updatedAt) || 0,
      };
    } catch {
      return { ok: false, conflict: true };
    }
  }
  if (!res.ok) {
    let err = `保存会话失败（${res.status}）`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) err = j.error;
    } catch {
      /* ignore */
    }
    console.warn("[api] saveChatSessions:", err);
    return { ok: false };
  }
  try {
    const j = (await res.json()) as { ok?: boolean; revision?: number; updatedAt?: number };
    return { ok: true, revision: Number(j.revision) || 0, updatedAt: Number(j.updatedAt) || 0 };
  } catch {
    return { ok: true };
  }
}

/** 从当前检索文献摘要用 LLM 抽数值 + 本机 Matplotlib 出图（需 Python3 与 matplotlib） */
export async function requestPaperChartFromPapers(
  papers: Paper[],
  opts: {
    parentOperationId: string;
    hint?: string;
    synthesisMarkdown?: string | null;
    idempotencyKey?: string;
  },
): Promise<PaperChartApiResult> {
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();
  const res = await fetch("/api/v1/chart/from-papers", {
    method: "POST",
    headers: headersJson({ "Idempotency-Key": idempotencyKey }),
    body: JSON.stringify({
      parentOperationId: opts.parentOperationId,
      papers: papers.map(slimPaperForChartApi),
      hint: opts.hint?.trim().slice(0, 500) || undefined,
      synthesisMarkdown: opts.synthesisMarkdown?.trim().slice(0, 8000) || undefined,
    }),
  });
  const text = await res.text();
  // #region agent log
  const _dbgPayload = {
    sessionId: "ef7a54",
    hypothesisId: "H4",
    location: "api.ts:requestPaperChartFromPapers:response",
    message: "chart fetch raw response",
    data: {
      status: res.status,
      ct: res.headers.get("content-type"),
      textLen: text.length,
      textHead: text.slice(0, 280).replace(/\s+/g, " "),
    },
    timestamp: Date.now(),
  };
  fetch("http://127.0.0.1:7467/ingest/0e8c1981-4719-4a28-ab2f-2d5a4ae28120", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ef7a54" },
    body: JSON.stringify(_dbgPayload),
  }).catch(() => {});
  // #endregion
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // #region agent log
    const _dbgFail = {
      sessionId: "ef7a54",
      hypothesisId: "H4",
      location: "api.ts:requestPaperChartFromPapers:json-parse-fail",
      message: "chart response not valid JSON",
      data: {
        status: res.status,
        ct: res.headers.get("content-type"),
        textLen: text.length,
        textHead: text.slice(0, 400).replace(/\s+/g, " "),
      },
      timestamp: Date.now(),
    };
    fetch("http://127.0.0.1:7467/ingest/0e8c1981-4719-4a28-ab2f-2d5a4ae28120", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ef7a54" },
      body: JSON.stringify(_dbgFail),
    }).catch(() => {});
    // #endregion
    const looksHtml = text.trimStart().startsWith("<");
    if (res.status === 404 && looksHtml) {
      throw new Error(
        "图表接口返回 404（多为 HTML）：8787 上的后端仍是旧版本或未加载当前代码。请先结束占用端口的旧 node 进程，再在项目根目录执行 npm run dev 或 npm run dev:server，然后重试「生成图表」。可在浏览器打开 /api/health 确认已连到新服务。",
      );
    }
    if (res.status === 502 || res.status === 503) {
      throw new Error(
        `图表接口不可用（HTTP ${res.status}）：请确认本机 API 已在 127.0.0.1:8787 启动。`,
      );
    }
    throw new Error(
      looksHtml
        ? `图表接口返回了网页而非 JSON（HTTP ${res.status}），请确认通过 npm run dev 访问且 Vite 已将 /api 代理到后端。`
        : `图表接口返回非 JSON（HTTP ${res.status}）`,
    );
  }
  if (!res.ok) {
    throw apiErrorFrom(res.status, data, `生成图表失败（${res.status}）`);
  }
  const billing = parseBillingReceipt(data.billing ?? data.billingReceipt ?? data.receipt);
  const png = data.pngBase64;
  const svg = data.svgBase64;
  const title = data.title;
  if (typeof title !== "string" || !title) {
    throw new Error("图表响应不完整");
  }
  if (typeof png === "string" && png) {
    const spec = data.spec;
    return {
      mime: "image/png",
      pngBase64: png,
      svgBase64: null,
      title,
      spec: spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {},
      matplotlibStderr:
        typeof data.matplotlibStderr === "string" ? data.matplotlibStderr : undefined,
      note: typeof data.note === "string" ? data.note : undefined,
      billing,
    };
  }
  if (typeof svg === "string" && svg) {
    const spec = data.spec;
    return {
      mime: "image/svg+xml",
      pngBase64: null,
      svgBase64: svg,
      title,
      spec: spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {},
      note: typeof data.note === "string" ? data.note : undefined,
      billing,
    };
  }
  throw new Error("图表响应不完整（无 PNG 也无 SVG）");
}

export type UnpaywallOaResponse = {
  ok: true;
  doi: string;
  is_oa: boolean;
  oa_status: string | null;
  pdf_url: string | null;
  landing_url: string | null;
};

/** 通过 Unpaywall 查询 DOI 的合法开放获取 PDF 或落地页（服务端读 .env 邮箱） */
export async function fetchUnpaywallOaByDoi(doi: string): Promise<UnpaywallOaResponse> {
  const d = doi.trim();
  if (!d) throw new Error("缺少 DOI");
  const res = await fetch(`/api/v1/papers/unpaywall-oa?doi=${encodeURIComponent(d)}`, {
    method: "GET",
    headers: headersJson(),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`OA 查询返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    throw new Error(String(data.error || `OA 查询失败（${res.status}）`));
  }
  return {
    ok: true,
    doi: String(data.doi ?? d),
    is_oa: Boolean(data.is_oa),
    oa_status: data.oa_status != null ? String(data.oa_status) : null,
    pdf_url: data.pdf_url != null ? String(data.pdf_url) : null,
    landing_url: data.landing_url != null ? String(data.landing_url) : null,
  };
}

export type FlowchartArtifactResult = {
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
  note?: string;
};

/** 从综述 / synthesisPlan 生成 Mermaid 工艺流程图 */
export async function requestFlowchartArtifact(opts: {
  synthesisMarkdown?: string | null;
  synthesisPlan?: Record<string, unknown> | null;
  title?: string;
  query?: string;
}): Promise<FlowchartArtifactResult> {
  const res = await fetch("/api/v1/artifacts/flowchart", {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      synthesisMarkdown: opts.synthesisMarkdown?.trim().slice(0, 80_000) || undefined,
      synthesisPlan: opts.synthesisPlan ?? undefined,
      title: opts.title?.trim().slice(0, 200) || undefined,
      query: opts.query?.trim().slice(0, 2000) || undefined,
    }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(data.error || `流程图生成失败（${res.status}）`));
  }
  return {
    mermaid: String(data.mermaid ?? ""),
    steps: Array.isArray(data.steps) ? (data.steps as FlowchartArtifactResult["steps"]) : undefined,
    recipeLines: Array.isArray(data.recipeLines) ? data.recipeLines.map(String) : undefined,
    svgBase64: data.svgBase64 != null ? String(data.svgBase64) : null,
    title: data.title != null ? String(data.title) : undefined,
    note: data.note != null ? String(data.note) : undefined,
  };
}

/** 下载 PPTX（含要点、配方、工序、数据表与流程图） */
export async function downloadPptxArtifact(opts: {
  synthesisMarkdown?: string | null;
  synthesisPlan?: Record<string, unknown> | null;
  title?: string;
  query?: string;
}): Promise<Blob> {
  const res = await fetch("/api/v1/artifacts/pptx", {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      synthesisMarkdown: opts.synthesisMarkdown?.trim().slice(0, 80_000) || undefined,
      synthesisPlan: opts.synthesisPlan ?? undefined,
      title: opts.title?.trim().slice(0, 200) || undefined,
      query: opts.query?.trim().slice(0, 2000) || undefined,
    }),
  });
  if (!res.ok) {
    let err = `PPT 生成失败（${res.status}）`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) err = j.error;
    } catch {
      /* binary or empty */
    }
    throw new Error(err);
  }
  return res.blob();
}

/** 数据库渠道：按预设类型生成结构化数据表 */
export async function requestGenerateDataTable(
  papers: Paper[],
  tableType: string,
  opts?: { synthesisMarkdown?: string | null },
): Promise<{
  tableType: string;
  title: string;
  rows: Array<Record<string, string | undefined>>;
  note?: string;
}> {
  const res = await fetch("/api/v1/data-table/generate", {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      papers: papers.map(slimPaperForChartApi),
      tableType,
      synthesisMarkdown: opts?.synthesisMarkdown?.trim().slice(0, 8000) || undefined,
    }),
  });
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`数据表接口返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    throw new Error(String(data.error || `生成数据表失败（${res.status}）`));
  }
  return {
    tableType: String(data.tableType ?? tableType),
    title: String(data.title ?? "数据表"),
    rows: Array.isArray(data.rows) ? (data.rows as Array<Record<string, string | undefined>>) : [],
    note: data.note != null ? String(data.note) : undefined,
  };
}
