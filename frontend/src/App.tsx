import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { linkifySynthesisCitations } from "./linkifySynthesis";
import { splitSynthesisMarkdown } from "./synthesisSections";
import { PasswordInputWithToggle } from "./PasswordInputWithToggle";
import { APP_NAME } from "./branding";
import { AppLogo } from "./AppLogo";
import { LoadingIndicator, LoadingSpinner } from "./LoadingIndicator";
import {
  getMainSearchLoadingText,
  LOADING_CHART,
  LOADING_DATA_TABLE,
  LOADING_OA,
  LOADING_UPLOAD,
} from "./loadingCopy";
import type {
  ChangeEvent,
  ComponentPropsWithoutRef,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  ApiError,
  createIdempotencyKey,
  extractUploadedDocument,
  fetchPointBalance,
  fulfillPdf,
  searchPapersV1,
  searchPapersV1Stream,
  submitFeedback,
  requestPaperChartFromPapers,
  requestGenerateDataTable,
  fetchUnpaywallOaByDoi,
  downloadPptxArtifact,
  requestFlowchartArtifact,
} from "./api";
import type { StreamSearchEvent } from "./api";
import { saveAs } from "file-saver";
import { ProcessArtifactToolbar } from "./ProcessFlowchartPanel";
import { DataTableGeneratorPanel } from "./DataTableGeneratorPanel";
import type { DataTablePresetId } from "./dataTablePresets";
import { HistorySearchModal } from "./HistorySearchModal";
import { addDissatisfactionEntry, clearOutputPreferences, DISLIKE_ASPECTS } from "./outputPreferences";
import { InteractivePaperChart } from "./InteractivePaperChart";
import {
  clearLlmChatCompletionsUrl,
  clearOpenAiKey,
  clearOpenAiModel,
  getLlmChatCompletionsUrl,
  getOpenAiKey,
  getOpenAiModel,
  setLlmChatCompletionsUrl,
  setOpenAiKey,
  setOpenAiModel,
} from "./openaiKey";
import { useTheme } from "./theme";
import { ExportChatModal } from "./ExportChatModal";
import { pickWelcomeCopy } from "./welcomeCopy";
import { clearAuthSession, getAuthProfile } from "./authSession";
import { clearUserSessions, getSessionKey, loadSessions, mergeChatSessions, saveSessions, sessionsPayloadForServer } from "./storage";
import { fetchChatSessionsFromServer, saveChatSessionsToServer } from "./api";
import { getAuthToken } from "./authSession";
import { DEFAULT_PERSONA_LIST, fetchPersonaList, getPersonaId, setPersonaId } from "./persona";
import type {
  ArxivSearchField,
  BillingReceipt,
  ChatMessage,
  ChatSession,
  ChatSessionsSyncState,
  Paper,
  PointBalance,
  Pricing,
  PaperDataPoint,
  PaperSortKey,
  SearchChannel,
  UploadedAttachment,
} from "./types";

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 将 full 逐步露出：前段大步「一下跳出」，接近末尾时逐字，整体比固定单字更快 */
function useTypewriterSlice(full: string, runKey: string, enabled: boolean) {
  const [len, setLen] = useState(0);
  const fullRef = useRef(full);
  fullRef.current = full;

  useEffect(() => {
    setLen(0);
    if (!enabled) return;
    let n = 0;
    const id = window.setInterval(() => {
      const target = fullRef.current.length;
      const remaining = target - n;
      if (remaining <= 0) return;
      let step = 1;
      if (remaining > 200) step = 24;
      else if (remaining > 120) step = 14;
      else if (remaining > 60) step = 8;
      else if (remaining > 24) step = 3;
      n = Math.min(target, n + step);
      setLen(n);
    }, 10);
    return () => window.clearInterval(id);
  }, [runKey, enabled]);
  if (!enabled) return "";
  return full.slice(0, len);
}

/** 流式正文结束后延迟收起「思考过程」；resetSig 变化时重新展开 */
function useThinkingPanelCollapse(streamDone: boolean, resetSig: string) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(true);
  }, [resetSig]);
  useEffect(() => {
    if (!streamDone) return;
    const t = window.setTimeout(() => setOpen(false), 2200);
    return () => window.clearTimeout(t);
  }, [streamDone, resetSig]);
  return [open, setOpen] as const;
}

function TypewriterCaret({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span
      className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-px animate-pulse rounded-sm bg-[var(--t-prose-link)] align-baseline"
      aria-hidden
    />
  );
}

function createSession(): ChatSession {
  return { id: uid(), title: "新对话", updatedAt: Date.now(), messages: [] };
}

function sessionTitleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const t = firstUser?.content?.trim() || "新对话";
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
}

/** 去掉用户气泡里「📎 文件名」行，避免重复占用检索上下文 */
function stripAttachmentLineFromUserContent(s: string): string {
  return s
    .split("\n")
    .filter((ln) => !/^\s*📎/.test(ln))
    .join("\n")
    .trim();
}

/**
 * 将**本对话内**、本轮发送之前的轮次压入检索上下文（不含其它会话）。
 * 保留最近用户提问 + 助手回答摘要，供多轮指代消解。
 */
function buildSearchContextFromMessages(
  messages: ChatMessage[],
  maxTotalChars = 4800,
  channel?: SearchChannel,
): string {
  if (messages.length === 0) return "";
  const isWeb = channel === "web";
  const lines: string[] = [];
  let used = 0;
  let assistantUsed = 0;
  const maxAssistants = isWeb ? 2 : 2;
  const tail = messages.slice(-10);
  for (const m of tail) {
    if (used >= maxTotalChars - 80) break;
    if (m.role === "user") {
      const body = stripAttachmentLineFromUserContent(m.content).slice(0, 900);
      if (!body) continue;
      const line = `用户：${body}`;
      if (used + line.length > maxTotalChars) break;
      lines.push(line);
      used += line.length + 2;
    } else if (m.role === "assistant" && !m.error && assistantUsed < maxAssistants) {
      const syn = (m.meta?.synthesis ?? m.content ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, isWeb ? 900 : 700);
      if (!syn) continue;
      const line = isWeb ? `助手上一答（摘要）：${syn}` : `助手上一综述（摘要）：${syn}`;
      if (used + line.length > maxTotalChars) break;
      lines.push(line);
      used += line.length + 2;
      assistantUsed += 1;
    }
  }
  if (lines.length === 0) return "";
  const header = isWeb
    ? "【本对话上文 · 供指代消解与延续话题，回答须对齐此上下文】\n"
    : "【本对话上文 · 供指代消解与延续话题】\n";
  const body = lines.join("\n\n");
  const out = header + body;
  return out.length > maxTotalChars ? out.slice(0, maxTotalChars) : out;
}

function buildSearchResultIntro(
  msg: ChatMessage,
  n: number,
  scope: string,
  tail: string,
): string {
  if (msg.error) return msg.content;
  const isWeb = msg.meta?.channel === "web";
  if (n === 0) {
    if (isWeb) {
      return `未检索到相关网页来源（当前为**网页渠道**，不查论文库）。可换关键词、补充公司名/股票代码，或检查网络与 \`.env\` 中 \`WEB_SOURCES\` 是否正常。${scope}${tail}`;
    }
    return `未检索到匹配文献。可尝试更换关键词、短语检索（"..."）、或显式 \`author:\` / \`year:\` 约束。${scope}${tail}`;
  }
  if (isWeb) {
    return `共 **${n}** 条网页来源摘录（含链接与摘要，非论文库条目）。${scope}${tail}`;
  }
  return `共 **${n}** 条检索结果。${scope}${tail}`;
}

const QUERY_TABS: { field: ArxivSearchField; label: string; title: string }[] = [
  {
    field: "ti",
    label: "产品",
    title: "仅在论文标题中检索（arXiv：ti）。合金/腐蚀等应用向问题若结果跑题，可改用「材料」或「综合方案」",
  },
  { field: "abs", label: "材料", title: "仅在摘要中检索（arXiv：abs）" },
  { field: "all", label: "综合方案", title: "标题、摘要、全文等综合检索（arXiv：all）" },
];

function fieldScopeHint(field: ArxivSearchField): string {
  if (field === "ti") return "标题（产品）";
  if (field === "abs") return "摘要（材料）";
  return "全文综合（综合方案）";
}

function IconDatabase({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <ellipse cx="12" cy="5.5" rx="7" ry="3" />
      <path d="M5 5.5v4c0 1.66 3.13 3 7 3s7-1.34 7-3v-4" />
      <path d="M5 9.5v4c0 1.66 3.13 3 7 3s7-1.34 7-3v-4" />
      <path d="M5 13.5v3.5c0 1.66 3.13 3 7 3s7-1.34 7-3V13.5" />
    </svg>
  );
}

function IconPaperclip({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <path d="M21.44 11.05 12.25 20.24a5.98 5.98 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-8.49 8.49a2.5 2.5 0 0 1-3.54-3.54l8.13-8.12" />
    </svg>
  );
}

function IconMenu({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function IconGlobe({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function ComposerToolbar({
  channel,
  sort,
  queryField,
  patentsOnly,
  deepMine,
  onChannel,
  onSort,
  onQueryField,
  onPatentsOnly,
  onDeepMine,
  disabled,
}: {
  channel: SearchChannel;
  sort: PaperSortKey;
  queryField: ArxivSearchField;
  patentsOnly: boolean;
  deepMine: boolean;
  onChannel: (c: SearchChannel) => void;
  onSort: (s: PaperSortKey) => void;
  onQueryField: (v: ArxivSearchField) => void;
  onPatentsOnly: (v: boolean) => void;
  onDeepMine: (v: boolean) => void;
  disabled?: boolean;
}) {
  const seg = (c: SearchChannel, label: string, icon: ReactNode, hint: string) => {
    const on = channel === c;
    const onCls =
      c === "database"
        ? "bg-[var(--t-channel-db-bg)] text-[var(--t-channel-db-text)]"
        : "bg-[var(--t-channel-web-bg)] text-[var(--t-channel-web-text)]";
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        title={hint}
        disabled={disabled}
        onClick={() => onChannel(c)}
        className={[
          "qp-seg-btn qp-seg-btn--compact",
          on ? onCls : "",
          disabled ? "cursor-not-allowed opacity-45" : "",
        ].join(" ")}
      >
        <span className="opacity-90">{icon}</span>
        {label}
      </button>
    );
  };

  return (
    <div className="qp-composer-bar flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-[color:var(--t-br05)] bg-[var(--t-muted)] px-2 py-1">
      <div className="qp-seg-track qp-seg-track--compact w-[min(100%,11.5rem)] shrink-0" role="radiogroup" aria-label="检索来源">
        {seg(
          "web",
          "网页",
          <IconGlobe className="h-3 w-3" />,
          "全网网页检索；可选专利；不查论文库",
        )}
        {seg(
          "database",
          "数据库",
          <IconDatabase className="h-3 w-3" />,
          "自建库 / DOI / 文献库 + 并行全网检索；综述与网络回答合并输出",
        )}
      </div>

      {channel === "database" ? (
        <>
          <span className="qp-composer-vrule" aria-hidden />
          <div className="flex shrink-0 items-center gap-0.5" role="tablist" aria-label="检索范围">
            {QUERY_TABS.map((t) => {
              const active = queryField === t.field;
              return (
                <button
                  key={t.field}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={t.title}
                  disabled={disabled}
                  onClick={() => onQueryField(t.field)}
                  className={[
                    "qp-scope-tab qp-scope-tab--compact",
                    active ? "qp-scope-tab--active" : "",
                    disabled ? "cursor-not-allowed opacity-45" : "",
                  ].join(" ")}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <span className="qp-composer-vrule" aria-hidden />

      <div className="relative shrink-0">
        <select
          value={sort}
          disabled={disabled}
          onChange={(e) => onSort(e.target.value as PaperSortKey)}
          className="appearance-none rounded-md border border-[color:var(--t-br07)] bg-[var(--t-input-box)] py-0.5 pl-1.5 pr-5 text-[10px] text-[var(--t-sort-text)] focus:border-[color:var(--t-accent-ring)] focus:outline-none focus:ring-1 focus:ring-[color:var(--t-accent-muted)] disabled:cursor-not-allowed disabled:opacity-45"
          aria-label="结果排序"
        >
          <option value="relevance">相关度</option>
          <option value="submittedDate">提交时间</option>
          <option value="lastUpdatedDate">最近更新</option>
          <option value="citations">被引</option>
        </select>
        <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[7px] text-[var(--t-text-chevron)]">
          ▾
        </span>
      </div>

      <span className="qp-composer-vrule" aria-hidden />

      <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-[var(--t-text-muted)]">
        <label
          className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap hover:text-[var(--t-text)]"
          title="专利号 + 标题链接"
        >
          <input
            type="checkbox"
            className="h-3 w-3 qp-accent-input"
            checked={patentsOnly}
            onChange={(e) => {
              const v = e.target.checked;
              onPatentsOnly(v);
              if (v) onDeepMine(false);
            }}
            disabled={disabled}
          />
          <span>专利</span>
        </label>
        <label
          className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap hover:text-[var(--t-text)]"
          title="逐篇下载 PDF 并深度解析（较慢）"
        >
          <input
            type="checkbox"
            className="h-3 w-3 qp-accent-input"
            checked={deepMine}
            onChange={(e) => {
              const v = e.target.checked;
              onDeepMine(v);
              if (v) onPatentsOnly(false);
            }}
            disabled={disabled || patentsOnly}
          />
          <span>深度</span>
        </label>
      </div>
    </div>
  );
}

function normalizeDoiField(d?: string | null): string {
  return String(d ?? "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
}

/** 供 <a download> 使用的安全文件名（跨域时浏览器可能仍改为新标签打开） */
function safePdfDownloadName(p: Paper): string {
  const id = String(p.id || "").trim();
  const title = String(p.title || "").trim();
  const raw =
    (p.source === "arxiv" && id ? id : title || id || "paper")
      .replace(/[/\\?%*:|"<>#]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 120) || "paper";
  const root = raw.replace(/\.pdf$/i, "");
  return `${root}.pdf`;
}

function paperRowKey(p: Paper): string {
  return `${p.paper_id ?? p.id}-${p.id}`;
}

function isWebSourcePaper(p: Paper): boolean {
  return (
    p.source === "mcp_web" ||
    p.source === "ddg_web" ||
    p.source === "dataify_web" ||
    p.source === "tavily_web"
  );
}

function paperExcerptBody(p: Paper, maxChars: number): string {
  const t = String(p.summary ?? "").trim();
  if (!t) return "（无摘录文本，可点击「打开网址」查看原页）";
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
}

function PaperCard({
  p,
  onPdfFulfill,
  pdfDisabled,
  open,
  onOpenChange,
  maxExcerptChars = 420,
}: {
  p: Paper;
  onPdfFulfill?: (p: Paper, mode: "open" | "save") => void | Promise<void>;
  pdfDisabled?: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** 网页渠道展开区可显示更长摘录 */
  maxExcerptChars?: number;
}) {
  const [oaBusy, setOaBusy] = useState(false);
  const [oaErr, setOaErr] = useState<string | null>(null);
  const abs =
    p.summary.length > maxExcerptChars ? `${p.summary.slice(0, maxExcerptChars)}…` : p.summary;
  const authors =
    p.authors.length > 6 ? `${p.authors.slice(0, 6).join(", ")} 等` : p.authors.join(", ");
  const isWebSrc =
    p.source === "mcp_web" ||
    p.source === "ddg_web" ||
    p.source === "dataify_web" ||
    p.source === "tavily_web";
  const src = p.source
    ? p.source === "scopus"
      ? " · Scopus（爱思唯尔）"
      : isWebSrc
        ? " · 网页"
        : p.source === "ddg_patent" || p.source === "openalex_patent"
          ? " · 专利"
          : ` · ${p.source}`
    : "";
  const pageUrl = String(p.absUrl ?? "").trim();
  const urlPill =
    isWebSrc && /^https?:\/\//i.test(pageUrl) ? citationPillMeta(pageUrl) : null;
  const pdfHref = (p.pdfUrl || "").trim();
  const doiNorm = normalizeDoiField(p.doi);
  const doiHref =
    doiNorm && /^10\.\d{4,9}\//.test(doiNorm) ? `https://doi.org/${encodeURIComponent(doiNorm)}` : "";
  const doiPill = doiHref ? citationPillMeta(doiHref) : null;
  const patentNo = String(p.patentNumber ?? "").trim();
  const patentPill =
    patentNo &&
    (p.source === "ddg_patent" || p.source === "openalex_patent")
      ? { label: `专利 ${patentNo.length > 18 ? `${patentNo.slice(0, 16)}…` : patentNo}`, title: `专利号：${patentNo}` }
      : null;
  const pillClass =
    "inline-flex max-w-[11rem] shrink-0 cursor-default items-center truncate rounded-full border border-[color:var(--t-br08)] bg-[color:var(--t-chip-bg)] px-2 py-0.5 text-[10px] font-medium leading-none text-[var(--t-text-muted)] no-underline transition-colors hover:border-[color:var(--t-br12)] hover:bg-[color:var(--t-muted-hover)] hover:text-[var(--t-text-secondary)]";
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) onOpenChange(next);
      }}
      className="group/pc rounded-xl border border-[color:var(--t-br07)] bg-[var(--t-elevated)] transition-colors duration-150 open:border-[color:var(--t-br11)] hover:border-[color:var(--t-br11)]"
    >
      <summary className="list-none cursor-pointer select-none p-3 outline-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-start gap-2">
          <span
            className={`mt-1.5 shrink-0 text-[10px] leading-none text-[var(--t-text-dim)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
            aria-hidden
          >
            ▸
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold leading-snug text-[var(--t-text-card-title)] transition-colors group-hover/pc:text-[var(--t-text-card-title-hover)]">
              {p.title}
            </h3>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--t-text-muted)]">
              <span>
                {authors}
                {p.published ? ` · ${p.published.slice(0, 10)}` : ""}
                {src}
              </span>
              {doiPill ? (
                <a href={doiHref} target="_blank" rel="noreferrer" title={doiPill.title} className={pillClass}>
                  {doiPill.label}
                </a>
              ) : null}
              {patentPill ? (
                <span title={patentPill.title} className={pillClass}>
                  {patentPill.label}
                </span>
              ) : null}
              {urlPill ? (
                <a href={pageUrl} target="_blank" rel="noreferrer" title={urlPill.title} className={pillClass}>
                  {urlPill.label}
                </a>
              ) : null}
            </p>
            <p className="mt-1 text-[10px] text-[var(--t-text-dim)]">单击展开摘要、链接与下载</p>
          </div>
        </div>
      </summary>
      <div className="border-t border-[color:var(--t-br06)] px-3 pb-3 pt-2">
        {p.dataPoints?.length ? <PaperSourceDataPoints points={p.dataPoints} /> : null}
        <p className={`text-sm leading-relaxed text-[var(--t-text-card-body)] ${p.dataPoints?.length ? "mt-2" : ""}`}>
          {abs}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            className="qp-btn-accent inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-medium"
            href={p.absUrl}
            target="_blank"
            rel="noreferrer"
          >
            {isWebSrc
              ? "打开网址"
              : p.source === "ddg_patent" || p.source === "openalex_patent"
                ? "专利来源"
                : "摘要页"}
          </a>
          {pdfHref || p.pdfSourceId || p.sourceId ? (
            <>
              <button
                type="button"
                disabled={pdfDisabled}
                className="inline-flex items-center rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-[var(--t-text)] hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void onPdfFulfill?.(p, "open")}
                title={pdfDisabled ? "积分已用完，暂不能获取 PDF" : "经服务端验证并获取 PDF，成功后收费 1 积分"}
              >
                PDF
              </button>
              <button
                type="button"
                disabled={pdfDisabled}
                className="inline-flex items-center rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void onPdfFulfill?.(p, "save")}
                title={pdfDisabled ? "积分已用完，暂不能获取 PDF" : "成功获取并验证 PDF 后保存，收费 1 积分"}
              >
                下载
              </button>
            </>
          ) : null}
          {doiNorm && /^10\.\d{4,9}\//.test(doiNorm) ? (
            <button
              type="button"
              disabled={oaBusy || pdfDisabled}
              onClick={() => {
                if (!doiNorm || !/^10\.\d{4,9}\//.test(doiNorm)) {
                  setOaErr("无有效 DOI");
                  return;
                }
                setOaBusy(true);
                setOaErr(null);
                void (async () => {
                  try {
                    if (onPdfFulfill && (p.pdfSourceId || p.sourceId)) {
                      await onPdfFulfill(p, "open");
                      return;
                    }
                    const r = await fetchUnpaywallOaByDoi(doiNorm);
                    const url = (r.pdf_url || r.landing_url || "").trim();
                    if (url) {
                      window.open(url, "_blank", "noopener,noreferrer");
                    } else {
                      setOaErr(
                        r.is_oa
                          ? "标记为 OA 但未返回可用链接，可稍后在 DOI 页查看"
                          : "Unpaywall：非 OA 或未收录",
                      );
                    }
                  } catch (e) {
                    setOaErr(e instanceof Error ? e.message : "OA 查询失败");
                  } finally {
                    setOaBusy(false);
                  }
                })();
              }}
              title={
                p.pdfSourceId || p.sourceId
                  ? "通过服务端验证并获取 OA PDF，成功后收费 1 积分"
                  : "仅查询 Unpaywall 外部链接；落地页不表示已完成收费 PDF 交付"
              }
              className="inline-flex items-center rounded-lg border border-[color:var(--t-br10)] bg-[var(--t-muted)] px-3 py-1.5 text-xs font-medium text-[var(--t-text)] hover:bg-[var(--t-muted-hover)] disabled:opacity-50"
            >
              {oaBusy ? LOADING_OA : "OA PDF（Unpaywall）"}
            </button>
          ) : null}
          {oaErr ? (
            <span className="inline-flex max-w-full items-center rounded-lg border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] text-red-600 dark:text-red-400">
              {oaErr}
            </span>
          ) : null}
          <span className="inline-flex items-center rounded-lg border border-border-subtle px-2 py-1 font-mono text-[11px] text-[var(--t-text-dim)]">
            {p.id}
          </span>
        </div>
      </div>
    </details>
  );
}

type ExtractedDataRow = {
  metric?: string;
  value?: string;
  unit?: string;
  condition?: string;
  source_ref?: string;
  context?: string;
  material?: string;
};

function PaperSourceDataPoints({ points }: { points: PaperDataPoint[] }) {
  if (!points.length) return null;
  return (
    <div className="mt-2 rounded-lg border border-[color:var(--t-br07)] bg-[var(--t-accent-muted)]/50 px-2.5 py-2">
      <p className="mb-1.5 text-[10px] font-semibold text-[var(--t-text-muted)]">
        本页摘录中的数据（{points.length} 项）
      </p>
      <ul className="space-y-1.5">
        {points.map((d, i) => (
          <li key={i} className="text-[11px] leading-snug text-[var(--t-text-card-body)]">
            <span className="font-medium text-[var(--t-text)]">{d.metric}</span>
            <span className="mx-1.5 tabular-nums font-semibold text-[var(--t-prose-link)]">{d.value}</span>
            {d.unit ? <span className="text-[var(--t-text-secondary)]">{d.unit}</span> : null}
            {d.condition ? (
              <span className="text-[var(--t-text-dim)]"> · {d.condition}</span>
            ) : null}
            {d.context ? (
              <span className="mt-0.5 block text-[10px] text-[var(--t-text-dim)]">「{d.context.slice(0, 80)}」</span>
            ) : null}
            {d.via === "synthesis" ? (
              <span className="ml-1 rounded bg-[var(--t-chip-bg)] px-1 py-px text-[9px] text-[var(--t-text-caption)]">
                综述归纳
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExtractedDataPanel({ plan }: { plan: Record<string, unknown> }) {
  const rows = (Array.isArray(plan.extractedData) ? plan.extractedData : []) as ExtractedDataRow[];
  if (!rows.length) return null;
  return (
    <details className="mt-3 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-2">
      <summary className="cursor-pointer list-none text-[11px] font-semibold text-[var(--t-text)] [&::-webkit-details-marker]:hidden">
        关键数据（结构化，共 {rows.length} 条）· 点击展开
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-left text-[11px]">
          <thead>
            <tr className="border-b border-[color:var(--t-br08)] text-[var(--t-text-label)]">
              <th className="py-1.5 pr-2 font-medium">指标</th>
              <th className="py-1.5 pr-2 font-medium">数值</th>
              <th className="py-1.5 pr-2 font-medium">单位</th>
              <th className="py-1.5 pr-2 font-medium">条件</th>
              <th className="py-1.5 font-medium">来源</th>
            </tr>
          </thead>
          <tbody className="text-[var(--t-text-card-body)]">
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[color:var(--t-br05)] align-top">
                <td className="py-1.5 pr-2 font-medium text-[var(--t-text)]">{r.metric ?? "—"}</td>
                <td className="py-1.5 pr-2 tabular-nums">{r.value ?? "—"}</td>
                <td className="py-1.5 pr-2">{r.unit ?? "—"}</td>
                <td className="py-1.5 pr-2 max-w-[10rem]">{r.condition ?? r.material ?? "—"}</td>
                <td className="py-1.5 text-[var(--t-text-dim)]">{r.source_ref ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="qp-user-bubble whitespace-pre-wrap">{text}</div>
    </div>
  );
}

function sortLabel(s?: PaperSortKey): string {
  if (s === "submittedDate") return "提交时间";
  if (s === "lastUpdatedDate") return "最近更新";
  if (s === "citations") return "被引次数（近似）";
  return "相关度";
}

function channelLabel(c?: SearchChannel): string {
  return c === "database"
    ? "数据库 + 全网（自建库/文献库与网页结果合并）"
    : "网页+专利（无论文库；网页须带网址）";
}

/** 文献数值图仅用于数据库渠道，网页渠道不展示、不自动作图 */
function channelSupportsPaperChart(c?: SearchChannel): boolean {
  return c !== "web";
}

/** 数据源列表里对用户更易读的标签 */
function formatSourceUsedTag(tag: string): string {
  if (tag === "scopus") return "Scopus（爱思唯尔）";
  if (tag === "mode:web_patent_intel") return "模式：网页+专利";
  if (tag === "mode:web_only") return "模式：仅全网网页";
  if (tag.startsWith("semantic:")) return "语义理解";
  if (tag.startsWith("embed:")) return "向量重排";
  if (tag.startsWith("web:")) return `网页（${tag.slice(4)}）`;
  if (
    tag === "ddg_web" ||
    tag === "mcp_web" ||
    tag === "dataify_web" ||
    tag === "tavily_web" ||
    tag === "searx_web" ||
    tag === "qwant_web" ||
    tag === "mojeek_web"
  )
    return "网页";
  if (tag === "openalex_patents" || tag.startsWith("patents:")) return "专利";
  return tag;
}

function formatQueryIntentBrief(intent?: import("./types").QueryIntent | null): string {
  if (!intent) return "";
  const parts: string[] = [];
  if (intent.summaryZh?.trim()) parts.push(intent.summaryZh.trim());
  if (intent.materials?.length) parts.push(`材料：${intent.materials.slice(0, 4).join("、")}`);
  if (intent.properties?.length) parts.push(`性能：${intent.properties.slice(0, 4).join("、")}`);
  if (intent.searchTerms?.length) parts.push(`检索词：${intent.searchTerms.slice(0, 5).join(", ")}`);
  if (intent.typoFixes?.length) parts.push(`纠错：${intent.typoFixes.slice(0, 4).join("、")}`);
  return parts.join(" · ");
}

function buildSynthesisThinkingLines(msg: ChatMessage): string[] {
  const lines: string[] = [];
  if (msg.error) return lines;
  const meta = msg.meta;
  const n = msg.papers?.length ?? 0;
  lines.push(
    meta?.channel === "web"
      ? `已纳入 ${n} 条网页摘录参与本轮联网回答编排。`
      : `已纳入 ${n} 条检索摘录参与本轮文献综述编排。`,
  );
  const eq = String(meta?.effectiveQuery ?? "").trim();
  if (eq) lines.push(`有效检索 / 改写：${eq.length > 200 ? `${eq.slice(0, 200)}…` : eq}`);
  if (meta) {
    lines.push(`渠道：${channelLabel(meta.channel)} · 排序：${sortLabel(meta.sort)}`);
  }
  const qi = formatQueryIntentBrief(meta?.queryIntent ?? null);
  if (qi) lines.push(`语义理解：${qi}`);
  const sn = String(meta?.synthesisNote ?? "").trim();
  if (sn) lines.push(`合成备注：${sn}`);
  const mode = String(meta?.synthesisModels?.mode ?? "").trim();
  if (mode) lines.push(`模型编排：${mode}`);
  const m = sn.match(/sources=(\d+)\/(\d+)\|filtered=(\d+)/);
  if (m) {
    lines.push(`摘录筛选：强相关依据约 ${m[1]} 条（候选 ${m[2]} 条，剔除弱相关 ${m[3]} 条）。`);
  }
  const tags = meta?.sourcesUsed?.filter(Boolean) ?? [];
  if (tags.length) {
    const shown = tags.slice(0, 10).map(formatSourceUsedTag);
    lines.push(`数据源：${shown.join("、")}${tags.length > 10 ? "…" : ""}`);
  }
  return lines;
}

function buildDeepThinkingLines(msg: ChatMessage): string[] {
  const lines: string[] = [];
  if (msg.error) return lines;
  lines.push("以下为深度管线（PDF / MinerU / 模型关键词）附属综合的编排说明。");
  const note = String(msg.meta?.deepSynthesisNote ?? msg.meta?.deepMine?.note ?? "").trim();
  if (note) lines.push(`管线说明：${note.length > 220 ? `${note.slice(0, 220)}…` : note}`);
  const models = msg.meta?.deepMine?.models?.filter(Boolean) as string[] | undefined;
  if (models?.length) lines.push(`参与模型：${models.slice(0, 8).join("、")}`);
  return lines;
}

function formatThinkingSeconds(latencyMs?: number | null): string | null {
  const ms = Number(latencyMs);
  if (!Number.isFinite(ms) || ms < 500) return null;
  const sec = Math.max(1, Math.round(ms / 1000));
  return `${sec} 秒`;
}

function AutoThinkingDetails({
  open,
  setOpen,
  streamDone,
  lines,
  latencyMs,
  deepSeekStyle,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  streamDone: boolean;
  lines: string[];
  latencyMs?: number | null;
  deepSeekStyle?: boolean;
}) {
  if (!lines.length) return null;
  const dur = formatThinkingSeconds(latencyMs);
  const summaryMain = deepSeekStyle
    ? !streamDone
      ? "正在思考…"
      : open
        ? dur
          ? `已思考（用时 ${dur}）`
          : "已思考"
        : dur
          ? `已思考（用时 ${dur}）`
          : "已思考"
    : !streamDone
      ? "思考过程（编排信息 · 输出进行中…）"
      : open
        ? "思考过程（编排信息 · 点击收起）"
        : "思考过程（编排信息 · 已收起，点击展开）";
  const chevron = open ? "▼" : "▶";
  return (
    <div className="not-prose mb-3 w-full max-w-none">
      <button
        type="button"
        className={deepSeekStyle ? "qp-thinking-bar" : "flex w-full items-center gap-2 rounded-lg border border-[color:var(--t-br08)] bg-[color:var(--t-chip-bg)] px-3 py-2.5 text-left text-[12px] font-semibold text-[var(--t-text)] transition-colors hover:bg-[color:var(--t-muted-hover)]/40"}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {!streamDone ? (
          <span
            className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--t-prose-link)]"
            aria-hidden
          />
        ) : (
          <span className="shrink-0 text-[11px] text-[var(--t-text-dim)]" aria-hidden>
            {chevron}
          </span>
        )}
        <span className="min-w-0 flex-1 leading-snug">{summaryMain}</span>
      </button>
      {open ? (
        <div
          className={
            deepSeekStyle
              ? "mt-1 rounded-lg border border-[color:var(--t-br06)] bg-[var(--t-field)] px-3 py-2"
              : "rounded-lg border border-[color:var(--t-br08)] bg-[color:var(--t-chip-bg)] px-3 py-2"
          }
        >
          <p className="text-[10px] leading-snug text-[var(--t-text-dim)]">
            检索编排摘要（渠道、改写、数据源等），便于对照正文；非模型链式推理全文。
          </p>
          <ul className="mt-1.5 list-outside list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-[var(--t-text-secondary)]">
            {lines.map((line, idx) => (
              <li key={idx} className="pl-0.5">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** 联网回答 [n] 引用：纯数字时显示为圆形角标（类似 DeepSeek） */
function WebSynthCitationLink({ href, children }: { href?: string; children?: ReactNode }) {
  const h = String(href ?? "").trim();
  const label = String(children ?? "").trim();
  if (/^\d{1,2}$/.test(label) && /^https?:\/\//i.test(h)) {
    const { title } = citationPillMeta(h);
    return (
      <a href={h} target="_blank" rel="noreferrer" title={title} className="qp-cite-num">
        {label}
      </a>
    );
  }
  return <SynthesisMarkdownLink href={href}>{children}</SynthesisMarkdownLink>;
}

/** 综述里外链：GPT 式小角标，悬停 title 显示完整 DOI / URL */
function citationPillMeta(href: string): { label: string; title: string } {
  const h = String(href ?? "").trim();
  if (!h) return { label: "·", title: "" };
  if (!/^https?:\/\//i.test(h)) {
    return { label: h.length > 14 ? `${h.slice(0, 12)}…` : h, title: h };
  }
  try {
    const u = new URL(h);
    const host = u.hostname.replace(/^www\./i, "");
    if (host === "doi.org" || host.endsWith(".doi.org")) {
      let path = u.pathname.replace(/^\//, "");
      try {
        path = decodeURIComponent(path);
      } catch {
        /* keep path */
      }
      const doiLine = path.startsWith("10.") ? `DOI: ${path}` : h;
      return { label: "DOI", title: `${doiLine}\n点击在新标签打开` };
    }
    if (host.includes("arxiv.org")) {
      return { label: "arXiv", title: `${h}\n点击在新标签打开` };
    }
    const short = host.length > 22 ? `${host.slice(0, 20)}…` : host;
    return { label: short, title: `${h}\n点击在新标签打开` };
  } catch {
    return { label: "链接", title: `${h}\n点击在新标签打开` };
  }
}

/** 综述 Markdown 中的围栏代码块：右上角一键复制（与 synthesisPlan 折叠区按钮风格一致） */
const SynthesisPreWithCopy = forwardRef<
  HTMLPreElement,
  ComponentPropsWithoutRef<"pre">
>(function SynthesisPreWithCopy({ children, className, ...rest }, ref) {
  const onCopy = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const root = e.currentTarget.closest(".syn-md-pre-wrap");
    const pre = root?.querySelector("pre");
    const t = pre?.innerText ?? "";
    if (t) void navigator.clipboard.writeText(t);
  }, []);
  return (
    <div className="syn-md-pre-wrap relative my-3">
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-2 top-2 z-10 rounded-md border qp-btn-accent rounded-md px-2.5 py-1 text-[10px]"
      >
        一键复制
      </button>
      <pre
        ref={ref}
        className={[className, "!pr-[5.5rem]"].filter(Boolean).join(" ")}
        {...rest}
      >
        {children}
      </pre>
    </div>
  );
});

function SynthesisMarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const h = String(href ?? "").trim();
  if (!h) return <span className="text-[var(--t-text-dim)]">{children}</span>;
  if (!/^https?:\/\//i.test(h)) {
    return (
      <a
        href={h}
        className="font-medium text-[var(--t-prose-link)] underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  }
  const { label, title } = citationPillMeta(h);
  return (
    <a
      href={h}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="ml-0.5 inline-flex max-w-[11rem] cursor-default items-center truncate rounded-full border border-[color:var(--t-br08)] bg-[color:var(--t-chip-bg)] px-2 py-0.5 align-middle text-[10px] font-medium leading-none text-[var(--t-text-muted)] no-underline transition-colors hover:border-[color:var(--t-br12)] hover:bg-[color:var(--t-muted-hover)] hover:text-[var(--t-text-secondary)]"
    >
      {label}
    </a>
  );
}

type AssistantFeedbackDetail = {
  aspects?: string[];
  note?: string;
  /** 仅提交「不满意」计数，不写入本机输出偏好 */
  skipPreference?: boolean;
};

function formatPoints(value: number | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "—";
}



function BillingReceiptBadge({ receipt, kind }: { receipt?: BillingReceipt | null; kind: "回答" | "图表" | "PDF" }) {
  if (!receipt) return null;
  const details = receipt.billingDetails ?? {};
  const quantity =
    kind === "回答"
      ? details.characterCount
      : kind === "图表"
        ? details.validPointCount ?? details.pointCount ?? details.chartPointCount
        : details.pdfCount ?? details.deepPaperCount;
  const unit = kind === "回答" ? "字符" : kind === "图表" ? "有效数据点" : "文件";
  return (
    <div className="not-prose mt-2 inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-[color:var(--t-br07)] bg-[var(--t-muted)] px-2 py-1 text-[10px] leading-snug text-[var(--t-text-muted)]">
      <span className="font-semibold text-[var(--t-text)]">{kind}计费</span>
      {typeof quantity === "number" ? <span>{quantity.toLocaleString()} {unit}</span> : null}
      <span>· 消费 {formatPoints(receipt.cost)} 积分</span>
      <span>· 余额 {formatPoints(receipt.balance)}</span>
    </div>
  );
}

function AssistantBlock({
  msg,
  onFeedback,
  onPdfFulfill,
  billingDisabled,
  feedbackLock,
  chartBusy,
  onMatplotlibChart,
  dataTableBusy,
  onGenerateDataTable,
  pptxBusy,
  flowBusy,
  onDownloadPptx,
  onBuildFlowchart,
}: {
  msg: ChatMessage;
  onFeedback?: (id: string, v: 1 | -1, detail?: AssistantFeedbackDetail) => void | Promise<void>;
  onPdfFulfill?: (msg: ChatMessage, p: Paper, mode: "open" | "save") => void | Promise<void>;
  billingDisabled?: boolean;
  feedbackLock?: 1 | -1;
  chartBusy?: boolean;
  onMatplotlibChart?: (msg: ChatMessage, hint?: string) => void | Promise<void>;
  dataTableBusy?: boolean;
  onGenerateDataTable?: (msg: ChatMessage, tableType: DataTablePresetId) => void | Promise<void>;
  pptxBusy?: boolean;
  flowBusy?: boolean;
  onDownloadPptx?: (msg: ChatMessage) => void | Promise<void>;
  onBuildFlowchart?: (msg: ChatMessage) => void | Promise<void>;
}) {
  const { theme } = useTheme();
  const n = msg.papers?.length ?? 0;
  const scope =
    msg.meta?.channel === "web" && !msg.error
      ? `\n\n*范围：全网网页（非 arXiv / 数据库论文）*`
      : msg.arxivField && !msg.error
        ? `\n\n*字段：${fieldScopeHint(msg.arxivField)}*`
        : "";
  const ch = channelLabel(msg.meta?.channel);
  const sl = sortLabel(msg.meta?.sort);
  const personaBit =
    !msg.error && msg.meta?.personaLabel
      ? ` · 身份：${msg.meta.personaLabel}`
      : "";
  const semanticBit =
    !msg.error && msg.meta?.queryIntent
      ? `\n\n*语义理解：${formatQueryIntentBrief(msg.meta.queryIntent)}*`
      : "";
  const tail =
    !msg.error && msg.meta
      ? `\n\n*渠道：${ch} · 排序：${sl} · 改写：${msg.meta.rewriteNote ?? "-"} · 耗时 ${msg.meta.latencyMs ?? "-"} ms · 数据源：${(msg.meta.sourcesUsed ?? []).map(formatSourceUsedTag).join("、") || "-"}${personaBit}*${semanticBit}`
      : "";

  const intro = buildSearchResultIntro(msg, n, scope, tail);

  const proseBase =
    "font-sans prose-sans prose-sm max-w-none prose-p:leading-relaxed prose-headings:font-semibold prose-a:[color:var(--t-prose-link)]";
  const proseTheme = theme === "light" ? "prose prose-slate" : "prose prose-invert";

  const synthesisParts = useMemo(() => {
    const raw = msg.meta?.synthesis?.trim() ?? "";
    if (!raw) {
      return {
        directMd: "",
        indirectMd: "",
        hasIndirectSection: false,
      };
    }
    const split = splitSynthesisMarkdown(raw);
    return {
      directMd: split.directMarkdown
        ? linkifySynthesisCitations(split.directMarkdown, msg.papers)
        : linkifySynthesisCitations(raw, msg.papers),
      indirectMd: split.indirectMarkdown
        ? linkifySynthesisCitations(split.indirectMarkdown, msg.papers)
        : "",
      hasIndirectSection: split.hasIndirectSection && split.indirectMarkdown.length > 0,
    };
  }, [msg.meta?.synthesis, msg.papers]);
  const synthesisMd = synthesisParts.directMd + (synthesisParts.indirectMd ? `\n\n${synthesisParts.indirectMd}` : "");
  const hasSynthesisText = Boolean(synthesisMd.trim());
  const synthStreamEnabled = !msg.error && synthesisMd.length > 0 && msg.meta?.synthesisNote === "synth:streaming";
  const synthShown = useTypewriterSlice(synthesisMd, `${msg.id}:syn`, synthStreamEnabled);
  const webSseStreaming = msg.meta?.channel === "web" && synthStreamEnabled;
  const synthesisShown = webSseStreaming ? synthesisMd : synthShown;
  const synthStreamDone = !synthStreamEnabled || (!webSseStreaming && synthShown.length >= synthesisMd.length);
  const synthCaret = synthStreamEnabled && (webSseStreaming || synthShown.length < synthesisMd.length);
  const synthDirectShown = useMemo(() => {
    if (!synthStreamEnabled) return synthesisParts.directMd;
    const directLen = synthesisParts.directMd.length;
    if (synthShown.length <= directLen) return synthShown;
    return synthesisParts.directMd;
  }, [synthStreamEnabled, synthesisParts.directMd, synthShown]);
  const synthIndirectShown = useMemo(() => {
    if (!synthesisParts.indirectMd) return "";
    if (!synthStreamEnabled) return synthesisParts.indirectMd;
    const directLen = synthesisParts.directMd.length;
    if (synthShown.length <= directLen + 2) return "";
    return synthShown.slice(directLen + 2);
  }, [synthStreamEnabled, synthesisParts.directMd, synthesisParts.indirectMd, synthShown]);
  const isWebChannel = msg.meta?.channel === "web" && !msg.error;
  const synthesisMode = String(msg.meta?.synthesisModels?.mode ?? "");
  const webNoSynthNote = String(msg.meta?.synthesisNote ?? "").trim();
  const webSynthesisWaiting = /^synth:pending$/i.test(webNoSynthNote);
  const webSynthesisStreaming = /^synth:streaming$/i.test(webNoSynthNote);
  const webSynthesisPending = webSynthesisWaiting || webSynthesisStreaming;
  const isAttachmentSynthesis = synthesisMode.startsWith("attachment_");
  const isDbHybridAnswer =
    msg.meta?.channel === "database" &&
    !msg.error &&
    !!(msg.meta?.webAnswerDrafts || synthesisMode === "database_hybrid");
  const isWebTriAnswer = isDbHybridAnswer || (
    isWebChannel &&
    !webSynthesisPending &&
    !isAttachmentSynthesis
  );
  const webAnswerDrafts = msg.meta?.webAnswerDrafts ?? {};
  const webTriConfigIncomplete = synthesisMode.includes("config_incomplete");
  const webArbitrationSucceeded =
    synthesisMode === "web_tri_arbitration" ||
    synthesisMode === "web_tri_speculative_arbitration";
  const hasWebSynthesis = !!(synthesisMd && synthesisMd.trim());
  const showWebDualPane = (isWebChannel || isDbHybridAnswer) && n > 0;
  const showWebUnified = showWebDualPane && hasWebSynthesis;
  const webFilterHint = useMemo(() => {
    const note = String(msg.meta?.synthesisNote ?? "");
    const m = note.match(/sources=(\d+)\/(\d+)\|filtered=(\d+)/);
    if (!m) return null;
    return `联网回答依据 ${m[1]} 条强相关摘录（检索 ${m[2]} 条，已剔除跑题 ${m[3]} 条）`;
  }, [msg.meta?.synthesisNote]);
  /** 确为未配 Key 时才提示配 Key；no-relevant-sources 等勿误导为断网或未配 Key */
  const webNoSynthKeyHint = /no-llm-key|stub:no-llm/i.test(webNoSynthNote);
  const webNoSynthRelevanceHint =
    /no-relevant-sources|web_answer:empty|web_merge:empty|web_tri:empty-query/i.test(webNoSynthNote) &&
    !/direct_knowledge|web_direct:ok/i.test(webNoSynthNote);
  const webDirectKnowledgeHint =
    /direct_knowledge|pick_low_quality|web_tri_direct_knowledge/i.test(webNoSynthNote) ||
    msg.meta?.synthesisModels?.mode === "web_tri_direct_knowledge";

  const webSourceChips = useMemo(() => {
    if (!showWebDualPane || !hasWebSynthesis || !msg.papers?.length) return [];
    return msg.papers
      .map((p, idx) => {
        const url = String(p.absUrl ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return null;
        return {
          n: idx + 1,
          title: String(p.title ?? "来源").slice(0, 56) || url,
          url,
        };
      })
      .filter(Boolean)
      .slice(0, 12) as { n: number; title: string; url: string }[];
  }, [showWebDualPane, hasWebSynthesis, msg.papers]);
  const hasAbstractSynth =
    !!(synthesisMd && synthesisMd.trim()) ||
    (msg.meta?.synthesisPlan != null && typeof msg.meta.synthesisPlan === "object");
  const hasDeepBlock =
    !!(msg.meta?.deepSynthesis?.trim()) || (msg.meta?.deepMine?.papers?.length ?? 0) > 0;
  const hasConclusionBlock = hasAbstractSynth || hasDeepBlock;

  const deepSynthesisMd = useMemo(
    () =>
      msg.meta?.deepSynthesis?.trim()
        ? linkifySynthesisCitations(msg.meta.deepSynthesis, msg.papers)
        : "",
    [msg.meta?.deepSynthesis, msg.papers],
  );
  const deepStreamEnabled = !msg.error && deepSynthesisMd.length > 0 && synthStreamDone && msg.meta?.synthesisNote === "synth:streaming";
  const deepShown = useTypewriterSlice(deepSynthesisMd, `${msg.id}:deep`, deepStreamEnabled);
  const deepCaret = deepStreamEnabled && deepShown.length < deepSynthesisMd.length;
  const deepStreamDone = !deepSynthesisMd || deepShown.length >= deepSynthesisMd.length;
  const synthesisThinkingLines = useMemo(() => buildSynthesisThinkingLines(msg), [
    msg.id,
    msg.error,
    msg.papers?.length,
    msg.meta?.effectiveQuery,
    msg.meta?.channel,
    msg.meta?.sort,
    msg.meta?.rewriteNote,
    msg.meta?.latencyMs,
    msg.meta?.synthesisNote,
    msg.meta?.synthesisModels?.mode,
    msg.meta?.sourcesUsed,
    msg.meta?.queryIntent,
    msg.meta?.personaLabel,
  ]);
  const deepThinkingLines = useMemo(() => buildDeepThinkingLines(msg), [
    msg.id,
    msg.error,
    msg.meta?.deepSynthesisNote,
    msg.meta?.deepMine?.note,
    msg.meta?.deepMine?.models,
  ]);
  const showSynthesisThinkingPanel = !msg.error && hasAbstractSynth;
  const synthesisThinkingStreamDone = !hasSynthesisText || synthStreamDone;
  const hasSynthPlan = msg.meta?.synthesisPlan != null && typeof msg.meta.synthesisPlan === "object";
  const synthThinkingResetSig = `${msg.id}|syn|${synthesisMd.length}|p:${hasSynthPlan ? 1 : 0}`;
  const [synthThinkingOpen, setSynthThinkingOpen] = useThinkingPanelCollapse(
    synthesisThinkingStreamDone,
    synthThinkingResetSig,
  );
  const showDeepThinkingPanel = deepStreamEnabled && Boolean(deepSynthesisMd.trim());
  const deepThinkingResetSig = `${msg.id}|deep|${deepSynthesisMd.length}`;
  const [deepThinkingOpen, setDeepThinkingOpen] = useThinkingPanelCollapse(deepStreamDone, deepThinkingResetSig);
  const mdLinkComponents = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <SynthesisMarkdownLink href={href}>{children}</SynthesisMarkdownLink>
      ),
      pre: SynthesisPreWithCopy,
    }),
    [],
  );
  const webMdLinkComponents = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <WebSynthCitationLink href={href}>{children}</WebSynthCitationLink>
      ),
      pre: SynthesisPreWithCopy,
    }),
    [],
  );

  const paperKeys = useMemo(() => (msg.papers ?? []).map(paperRowKey), [msg.papers]);
  const paperKeysSig = paperKeys.join("|");
  const [openPaperKeys, setOpenPaperKeys] = useState<Set<string>>(() => new Set());
  /** 整条论文列表区域（工具栏 + 各条卡片）是否展开 */
  const [paperListSectionOpen, setPaperListSectionOpen] = useState(false);
  const [webRefsOpen, setWebRefsOpen] = useState(false);
  const [chartHint, setChartHint] = useState("");

  useEffect(() => {
    setOpenPaperKeys(new Set());
    setWebRefsOpen(false);
    setPaperListSectionOpen(msg.meta?.channel === "web" && !msg.meta?.synthesis?.trim());
  }, [msg.id, paperKeysSig, msg.meta?.channel, msg.meta?.synthesis]);

  const [negOpen, setNegOpen] = useState(false);
  const [negAspects, setNegAspects] = useState<Set<string>>(() => new Set());
  const [negNote, setNegNote] = useState("");
  useEffect(() => {
    setNegOpen(false);
    setNegAspects(new Set());
    setNegNote("");
  }, [msg.id]);

  const toggleNegAspect = (id: string) => {
    setNegAspects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitNegativeWithPrefs = () => {
    const aspects = [...negAspects];
    const note = negNote.trim();
    if (aspects.includes("other") && note.length < 3) {
      window.alert("选择「其它」时，请在说明里简要写清不满意之处（至少 3 个字）。");
      return;
    }
    if (!aspects.length && note.length < 3) {
      window.alert("请至少勾选一个方面，或写几句说明。");
      return;
    }
    void onFeedback?.(msg.id, -1, { aspects, note: note || undefined });
    setNegOpen(false);
  };

  const submitNegativeSkipPrefs = () => {
    void onFeedback?.(msg.id, -1, { skipPreference: true });
    setNegOpen(false);
  };

  return (
    <div className="max-w-[min(800px,100%)]">
      <div className={`${proseTheme} ${proseBase}`}>
        {msg.error ? (
          <p className="text-[var(--t-error)]">{intro}</p>
        ) : showWebDualPane && !hasWebSynthesis ? (
          webSynthesisPending ? null : (
            <p className="mb-2 text-[11px] text-[var(--t-text-dim)]">
              共 <strong>{n}</strong> 条网页/专利来源；
              {webNoSynthKeyHint
                ? "配置 Key 后可生成联网综合回答。"
                : "本轮未生成联网综合回答。"}
            </p>
          )
        ) : showWebDualPane ? null : (
          <ReactMarkdown>{intro}</ReactMarkdown>
        )}
        {!msg.error && (hasConclusionBlock || (showWebDualPane && !hasWebSynthesis)) ? (
          <div className={showWebDualPane ? "mt-1" : "mt-4 border-t border-[color:var(--t-br06)] pt-4"}>
            {hasAbstractSynth || (showWebDualPane && !hasWebSynthesis) ? (
              <>
                {showWebDualPane ? (
                  <>
                    {hasWebSynthesis ? (
                      <>
                        <div className="qp-answer-card qp-markdown-scroll not-prose max-w-none">
                          {showSynthesisThinkingPanel ? (
                            <AutoThinkingDetails
                              open={synthThinkingOpen}
                              setOpen={setSynthThinkingOpen}
                              streamDone={synthesisThinkingStreamDone}
                              lines={synthesisThinkingLines}
                              latencyMs={msg.meta?.latencyMs}
                              deepSeekStyle
                            />
                          ) : null}
                          {webDirectKnowledgeHint ? (
                            <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:text-amber-100">
                              本轮网页摘录匹配度不足，回答可能含<strong>未附摘录的常识推断</strong>。关键事实请点开下方来源核对，或换更具体关键词重试。
                            </p>
                          ) : null}
                          <p className="mb-2 text-[11px] font-semibold text-[var(--t-text-muted)]">
                            {webSynthesisStreaming ? (
                              <span className="inline-flex items-center gap-1.5">
                                <LoadingSpinner className="h-3 w-3 shrink-0 border-[var(--t-accent)] border-t-transparent" />
                                预览回答 · 双模型作答与第三模型仲裁中…
                              </span>
                            ) : webArbitrationSucceeded
                              ? `模型 C 仲裁终稿${msg.meta?.synthesisModels?.modelC ? ` · ${msg.meta.synthesisModels.modelC}` : ""}`
                              : "联网综合回答（部分模型失败时可能为降级结果）"}
                          </p>
                          <div className={`${proseTheme} qp-web-synth qp-markdown-scroll relative max-w-none`}>
                            <ReactMarkdown components={webMdLinkComponents}>
                              {synthStreamEnabled ? synthesisShown : synthesisMd}
                            </ReactMarkdown>
                            <TypewriterCaret visible={synthCaret} />
                          </div>
                          {webSourceChips.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[color:var(--t-br06)] pt-3">
                              {webSourceChips.map((s) => (
                                <a
                                  key={`${s.n}-${s.url}`}
                                  href={s.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="qp-chip"
                                  title={s.url}
                                >
                                  <span className="qp-cite-num !ml-0">{s.n}</span>
                                  <span className="truncate">{s.title}</span>
                                </a>
                              ))}
                            </div>
                          ) : null}
                          {msg.meta?.synthesisPlan &&
                          typeof msg.meta.synthesisPlan === "object" ? (
                            <ExtractedDataPanel plan={msg.meta.synthesisPlan} />
                          ) : null}
                          {channelSupportsPaperChart(msg.meta?.channel) &&
                          !msg.error &&
                          n > 0 &&
                          onGenerateDataTable ? (
                            <DataTableGeneratorPanel
                              msg={msg}
                              busy={dataTableBusy}
                              onGenerate={onGenerateDataTable}
                            />
                          ) : null}
                          {onDownloadPptx && onBuildFlowchart ? (
                            <ProcessArtifactToolbar
                              msg={msg}
                              pptxBusy={pptxBusy}
                              flowBusy={flowBusy}
                              onDownloadPptx={onDownloadPptx}
                              onBuildFlowchart={onBuildFlowchart}
                            />
                          ) : null}
                        </div>
                      </>
                    ) : webSynthesisWaiting ? (
                      <div
                        className="mb-3 flex items-center gap-2.5 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-muted)] px-3 py-2.5 text-[11px] text-[var(--t-text-muted)]"
                        role="status"
                        aria-live="polite"
                        aria-busy="true"
                      >
                        <LoadingSpinner className="h-3.5 w-3.5 shrink-0 border-[var(--t-accent)] border-t-transparent" />
                        <span>
                          检索完成，已找到 <strong className="text-[var(--t-text)]">{n}</strong> 条来源。模型正在生成预览回答…
                        </span>
                      </div>
                    ) : (
                      <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200/90">
                        未生成联网综合回答
                        {webNoSynthNote ? `（${webNoSynthNote}）` : ""}。
                        {webNoSynthKeyHint
                          ? "请先在侧栏配置 LLM API Key 并保存后重试。"
                          : webNoSynthRelevanceHint
                            ? "检索已连网（见下方摘录）；用于双模型作答与第三模型仲裁的「强相关」摘录不足，为避免跑题未生成终稿。可换更具体的产品名、型号、英文关键词，或改用「数据库优先」。"
                            : "可稍后重试或查看后端日志中的 synthesisNote。"}
                        下方仍展示检索摘录。
                      </p>
                    )}
                    <details
                      className="mt-4 rounded-lg border border-[color:var(--t-br06)] bg-[var(--t-field)]"
                      open={webRefsOpen}
                      onToggle={(e) => setWebRefsOpen(e.currentTarget.open)}
                    >
                      <summary className="cursor-pointer list-none px-3 py-2.5 text-[12px] font-medium text-[var(--t-text-muted)] hover:text-[var(--t-text)] [&::-webkit-details-marker]:hidden">
                        <span className="mr-1.5 text-[var(--t-text-dim)]">{webRefsOpen ? "▼" : "▶"}</span>
                        引用来源（{n} 条网页/专利摘录）
                        {webFilterHint ? (
                          <span className="ml-2 font-normal text-[10px] text-[var(--t-text-dim)]">
                            · {webFilterHint}
                          </span>
                        ) : null}
                      </summary>
                      <div className="border-t border-[color:var(--t-br06)] px-3 pb-3 pt-2">
                        <p className="mb-2 text-[10px] text-[var(--t-text-dim)]">
                          点击 [n] 角标可打开对应链接；「已抓正文」表示已合并较长网页正文。
                        </p>
                        <div className="flex flex-col gap-2.5">
                        {(msg.papers ?? []).map((p, idx) => {
                          const url = String(p.absUrl ?? "").trim();
                          const fetched = p.webFetchNote === "fetched";
                          const excerptMax = fetched ? 2200 : 900;
                          return (
                            <article key={paperRowKey(p)} className="qp-excerpt-card">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="shrink-0 text-[11px] font-bold text-[var(--t-prose-link)]">[{idx + 1}]</span>
                                <h4 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-[var(--t-text-card-title)]">
                                  {p.title || "（无标题）"}
                                </h4>
                                {fetched ? (
                                  <span className="shrink-0 rounded bg-[var(--t-muted)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--t-text-muted)]">
                                    已抓正文
                                  </span>
                                ) : isWebSourcePaper(p) ? (
                                  <span className="shrink-0 rounded bg-[var(--t-chip-bg)] px-1.5 py-0.5 text-[9px] text-[var(--t-text-dim)]">
                                    检索摘要
                                  </span>
                                ) : (
                                  <span className="shrink-0 rounded bg-[var(--t-chip-bg)] px-1.5 py-0.5 text-[9px] text-[var(--t-text-dim)]">
                                    专利
                                  </span>
                                )}
                              </div>
                              {/^https?:\/\//i.test(url) ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="mt-1 block truncate text-[10px] text-[var(--t-prose-link)] hover:underline"
                                >
                                  {url}
                                </a>
                              ) : null}
                              {p.dataPoints?.length ? (
                                <PaperSourceDataPoints points={p.dataPoints} />
                              ) : null}
                              <p
                                className={`whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--t-text-card-body)] ${p.dataPoints?.length ? "mt-2" : "mt-2"}`}
                              >
                                {paperExcerptBody(p, excerptMax)}
                              </p>
                            </article>
                          );
                        })}
                        </div>
                      </div>
                    </details>
                  </>
                ) : (
                  <>
                    <p className="mb-1.5 text-[12px] font-semibold text-[var(--t-text)]">结论与方案（直接依据摘录）</p>
                    <p className="mb-2 text-[10px] text-[var(--t-text-dim)]">
                      与用户问题<strong>直接相关</strong>的论述在下文；仅类比/背景/弱相关文献在独立区块「间接参考」中列出，不与直接结论混写。接口字段{" "}
                      <code className="rounded bg-[var(--t-field)] px-1">synthesisPlan</code> 为结构化 JSON，灰框标题可点击展开。
                    </p>
                    {showSynthesisThinkingPanel ? (
                      <AutoThinkingDetails
                        open={synthThinkingOpen}
                        setOpen={setSynthThinkingOpen}
                        streamDone={synthesisThinkingStreamDone}
                        lines={synthesisThinkingLines}
                      />
                    ) : null}
                    {synthesisParts.directMd ? (
                      <div className="relative max-w-full">
                        <ReactMarkdown components={mdLinkComponents}>
                          {synthStreamEnabled ? synthDirectShown : synthesisParts.directMd}
                        </ReactMarkdown>
                        <TypewriterCaret
                          visible={
                            synthCaret &&
                            (!synthesisParts.indirectMd || synthDirectShown.length < synthesisParts.directMd.length)
                          }
                        />
                      </div>
                    ) : synthesisMd ? (
                      <div className="relative max-w-full">
                        <ReactMarkdown components={mdLinkComponents}>{synthShown}</ReactMarkdown>
                        <TypewriterCaret visible={synthCaret} />
                      </div>
                    ) : null}
                    {synthesisParts.hasIndirectSection && synthesisParts.indirectMd ? (
                      <div className="mt-4 rounded-lg border border-dashed border-amber-500/35 bg-amber-500/5 px-3 py-2.5">
                        <p className="mb-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300/90">
                          间接参考与延伸线索（非直接答案）
                        </p>
                        <p className="mb-2 text-[10px] text-[var(--t-text-dim)]">
                          下列内容来自跑题、邻近领域或仅可类比的摘录，供拓展阅读，<strong>不构成</strong>对上文的直接结论。
                        </p>
                        <div className="relative max-w-full opacity-95">
                          <ReactMarkdown components={mdLinkComponents}>{synthIndirectShown}</ReactMarkdown>
                          <TypewriterCaret
                            visible={
                              synthCaret &&
                              synthDirectShown.length >= synthesisParts.directMd.length &&
                              synthIndirectShown.length < synthesisParts.indirectMd.length
                            }
                          />
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
                {msg.meta?.synthesisPlan != null && typeof msg.meta.synthesisPlan === "object" ? (
                  <ExtractedDataPanel plan={msg.meta.synthesisPlan} />
                ) : null}
                {channelSupportsPaperChart(msg.meta?.channel) &&
                !msg.error &&
                n > 0 &&
                onGenerateDataTable ? (
                  <DataTableGeneratorPanel
                    msg={msg}
                    busy={dataTableBusy}
                    onGenerate={onGenerateDataTable}
                  />
                ) : null}
                {msg.meta?.synthesisPlan != null && typeof msg.meta.synthesisPlan === "object" ? (
                  <details className="mt-3 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-2">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-semibold text-[var(--t-text)] [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0">结构化方案（synthesisPlan）· 点击展开或收起</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-md border qp-btn-accent rounded-md px-2.5 py-1 text-[10px]"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void navigator.clipboard.writeText(JSON.stringify(msg.meta!.synthesisPlan!, null, 2));
                        }}
                      >
                        一键复制
                      </button>
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[var(--t-text-muted)]">
                      {JSON.stringify(msg.meta.synthesisPlan, null, 2)}
                    </pre>
                  </details>
                ) : null}
                {msg.meta?.synthesisPlan == null && msg.meta?.synthesisPlanNote ? (
                  <p className="mt-2 text-[10px] text-[var(--t-text-dim)]">
                    未得到独立结构化字段（{msg.meta.synthesisPlanNote}）。若模型未按格式输出末尾 json
                    块，可重试或检查模型输出。
                  </p>
                ) : null}
              </>
            ) : null}
            {hasDeepBlock ? (
              <>
                <p
                  className={`mb-1.5 text-[12px] font-semibold text-[var(--t-text)] ${hasAbstractSynth ? "mt-4 border-t border-[color:var(--t-br05)] pt-3" : ""}`}
                >
                  深度管线（MinerU + 三模型关键词）
                </p>
                <p className="mb-2 text-[10px] text-[var(--t-text-dim)]">
                  {msg.meta?.deepSynthesisNote ?? msg.meta?.deepMine?.note ?? "-"} · 全文下载须遵守版权与站点条款
                </p>
                {showDeepThinkingPanel ? (
                  <AutoThinkingDetails
                    open={deepThinkingOpen}
                    setOpen={setDeepThinkingOpen}
                    streamDone={deepStreamDone}
                    lines={deepThinkingLines}
                  />
                ) : null}
                {deepSynthesisMd ? (
                  <div className="relative max-w-full">
                    <ReactMarkdown components={mdLinkComponents}>{deepShown}</ReactMarkdown>
                    <TypewriterCaret visible={deepCaret} />
                  </div>
                ) : null}
                {msg.meta?.deepMine?.papers?.length ? (
                  <details className="mt-3 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-2">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-semibold text-[var(--t-text)] [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0">结构化数据（deepMine）· 点击展开</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-md border qp-btn-accent rounded-md px-2.5 py-1 text-[10px]"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void navigator.clipboard.writeText(JSON.stringify(msg.meta!.deepMine!, null, 2));
                        }}
                      >
                        一键复制
                      </button>
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[var(--t-text-muted)]">
                      {JSON.stringify(msg.meta.deepMine, null, 2).slice(0, 120000)}
                    </pre>
                  </details>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {isWebTriAnswer ? (
          <details className="not-prose mt-3 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-2">
            <summary className="cursor-pointer list-none text-[11px] font-semibold text-[var(--t-text)] [&::-webkit-details-marker]:hidden">
              两模型独立作答（仲裁前对照，点击展开）
            </summary>
            {webTriConfigIncomplete ? (
              <p className="mt-2 rounded border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-800 dark:text-amber-200">
                A/B 作答 Provider 或 C 仲裁 Provider 配置不完整；已展示实际执行结果，缺失或失败的作答模型会标记原因。
              </p>
            ) : null}
            <div className="mt-2 space-y-3 text-[11px] leading-relaxed text-[var(--t-text-muted)]">
              {(
                [
                  ["A", webAnswerDrafts.modelA, webAnswerDrafts.noteA, msg.meta?.synthesisModels?.modelA],
                  ["B", webAnswerDrafts.modelB, webAnswerDrafts.noteB, msg.meta?.synthesisModels?.modelB],
                ] as const
              ).map(([slot, md, note, modelName]) => (
                <div key={slot} className="rounded border border-[color:var(--t-br06)] bg-[var(--t-bg)] px-2 py-2">
                  <p className="mb-1 font-semibold text-[var(--t-text)]">
                    模型 {slot}
                    {modelName ? ` · ${modelName}` : ""}
                    {note ? ` · ${note}` : ""}
                  </p>
                  {md?.trim() ? (
                    <ReactMarkdown components={mdLinkComponents}>
                      {linkifySynthesisCitations(md, msg.papers)}
                    </ReactMarkdown>
                  ) : (
                    <p className="text-[var(--t-text-dim)]">
                      （未生成或调用失败{note ? `：${note}` : ""}）
                    </p>
                  )}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {!msg.error && msg.meta?.pointsExhausted ? (
          <div className="not-prose mt-3 rounded-lg border border-amber-500/45 bg-amber-500/10 px-3 py-2 text-[12px] font-medium leading-relaxed text-amber-800 dark:text-amber-200">
            {msg.meta.billingMessage || "积分已用完，本次回答已停止。请充值后继续回答。"}
          </div>
        ) : null}
        {!msg.error ? <BillingReceiptBadge receipt={msg.meta?.billing} kind="回答" /> : null}
        {!msg.error &&
        msg.papers &&
        msg.papers.length > 0 &&
        !msg.meta?.synthesis?.trim() &&
        msg.meta?.synthesisNote === "synth:no-llm-key" ? (
          <p className="mt-3 text-[12px] text-[var(--t-text-dim)]">
            {isWebChannel
              ? "未配置 LLM API Key（侧栏「查询重写」），已跳过联网综合回答；仍下列出网页来源摘录。配置 Key 后重试即可生成回答。"
              : "未配置 LLM API Key（侧栏「查询重写」），已跳过文献综述；仍下列出检索条目。配置 Key 并保存后重试即可生成带 DOI 标注的汇总回答。"}
          </p>
        ) : null}
        {!msg.error &&
        msg.papers &&
        msg.papers.length > 0 &&
        !msg.meta?.synthesis?.trim() &&
        msg.meta?.synthesisNote &&
        !webSynthesisPending &&
        msg.meta.synthesisNote !== "synth:no-llm-key" ? (
          <p className="mt-3 text-[12px] text-[var(--t-text-dim)]">
            {isWebChannel
              ? `本次未生成联网综合回答（${msg.meta.synthesisNote}）。下方仍为检索到的网页来源。`
              : `本次未生成文献综述（${msg.meta.synthesisNote}）。下方仍为检索到的文献条目。`}
          </p>
        ) : null}
      </div>
      {msg.papers && msg.papers.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPaperListSectionOpen((v) => !v)}
              className="qp-btn-list-toggle"
            >
              {paperListSectionOpen
                ? showWebUnified
                  ? "收起全部来源"
                  : "收起论文列表"
                : showWebUnified
                  ? "查看全部来源"
                  : "展开论文列表"}
              <span className="ml-1 font-normal text-[var(--t-text-muted)]">（{n} 条）</span>
            </button>
            {paperListSectionOpen ? (
              <>
                <button
                  type="button"
                  onClick={() => setOpenPaperKeys(new Set(paperKeys))}
                  className="qp-btn-ghost"
                >
                  条目全部展开
                </button>
                <button
                  type="button"
                  onClick={() => setOpenPaperKeys(new Set())}
                  className="qp-btn-ghost"
                >
                  条目全部收起
                </button>
              </>
            ) : null}
          </div>
          {paperListSectionOpen ? (
            <div className="flex flex-col gap-3">
              {msg.papers.map((p) => {
                const k = paperRowKey(p);
                return (
                  <PaperCard
                    key={k}
                    p={p}
                    maxExcerptChars={showWebDualPane ? 2800 : 420}
                    open={openPaperKeys.has(k)}
                    onOpenChange={(next) => {
                      setOpenPaperKeys((prev) => {
                        const nextSet = new Set(prev);
                        if (next) nextSet.add(k);
                        else nextSet.delete(k);
                        return nextSet;
                      });
                    }}
                    onPdfFulfill={(paper, mode) => onPdfFulfill?.(msg, paper, mode)}
                    pdfDisabled={billingDisabled}
                  />
                );
              })}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-2 text-[11px] text-[var(--t-text-dim)]">
              {showWebDualPane
                ? "来源列表已收起；上方「检索摘录」已展示主要原文片段，展开可查看全部条目与打开链接。"
                : "论文列表已收起。点击「展开论文列表」可再次查看全部条目与操作按钮。"}
            </p>
          )}
        </div>
      )}
      {msg.meta?.pdfReceipts?.map((receipt) => (
        <BillingReceiptBadge key={receipt.operationId} receipt={receipt} kind="PDF" />
      ))}
      {!msg.error && channelSupportsPaperChart(msg.meta?.channel) && msg.papers && msg.papers.length > 0 && onMatplotlibChart ? (
        <div className="mt-4 rounded-xl border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-3">
          <p className="mb-2 text-[11px] font-semibold text-[var(--t-text)]">文献数值图（可点击散点 + Matplotlib PNG）</p>
          <p className="mb-2 text-[10px] leading-relaxed text-[var(--t-text-dim)]">
            检索成功后会<strong>自动尝试</strong>作图：优先用 LLM 结合<strong>摘要 + 综述</strong>抽数；仍失败时会用摘要里的<strong>年份与首个 % / eV</strong>自动后备一张散点图（仍静默跳过若完全无数字）。也可填「作图意图」后点按钮重试。散点图下表列出各点横纵坐标对应的 DOI（`doi_x` /
            `doi_y`）。若本机已安装 Python3 与{" "}
            <code className="rounded bg-[var(--t-elevated)] px-0.5">matplotlib</code> 优先使用 Matplotlib PNG；否则使用纯 JS SVG 渲染。
          </p>
          {msg.meta?.paperChartError ? (
            <p className="mb-2 rounded-lg border border-[color:var(--t-error)]/35 bg-[color:var(--t-error)]/08 px-2 py-1.5 text-[10px] leading-relaxed text-[var(--t-error)]">
              {msg.meta.paperChartError}
            </p>
          ) : null}
          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-[10px] text-[var(--t-text-label)]">
              作图意图（可选）
              <input
                type="text"
                value={chartHint}
                onChange={(e) => setChartHint(e.target.value)}
                placeholder="如：横轴温度、纵轴效率；或留空由模型根据摘录推断"
                className="mt-0.5 w-full rounded-lg border border-[color:var(--t-br10)] bg-[var(--t-surface)] px-2 py-1.5 text-[11px] text-[var(--t-text)]"
              />
            </label>
            <button
              type="button"
              disabled={!!chartBusy || billingDisabled}
              onClick={() => void onMatplotlibChart(msg, chartHint.trim() || undefined)}
              className="qp-btn-accent shrink-0 rounded-lg px-3 py-2 text-[11px] disabled:opacity-50"
            >
              {chartBusy ? LOADING_CHART : msg.meta?.paperChart ? "重新生成图表" : "生成图表"}
            </button>
          </div>
          {msg.meta?.paperChart && (msg.meta.paperChart.pngBase64 || msg.meta.paperChart.svgBase64) ? (
            <div className="mt-3 border-t border-[color:var(--t-br06)] pt-3">
              <p className="mb-2 text-[11px] font-medium text-[var(--t-text)]">
                {msg.meta.paperChart.title}
                {msg.meta.paperChart.note ? (
                  <span className="ml-1 text-[10px] font-normal text-[var(--t-text-muted)]">({msg.meta.paperChart.note})</span>
                ) : null}
              </p>
              <BillingReceiptBadge receipt={msg.meta.paperChart.billing} kind="图表" />
              {msg.meta.paperChart.spec &&
              typeof msg.meta.paperChart.spec === "object" &&
              !Array.isArray(msg.meta.paperChart.spec) ? (
                <InteractivePaperChart spec={msg.meta.paperChart.spec} papers={msg.papers ?? []} />
              ) : null}
              {msg.meta.paperChart.pngBase64 ? (
                <>
                  <p className="mb-1 mt-2 text-[10px] text-[var(--t-text-dim)]">静态预览（PNG，不可点击）</p>
                  <img
                    src={`data:${msg.meta.paperChart.mime};base64,${msg.meta.paperChart.pngBase64}`}
                    alt={msg.meta.paperChart.title}
                    className="max-h-[min(72vh,720px)] w-full max-w-full rounded-lg border border-[color:var(--t-br08)] bg-white object-contain"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href={`data:${msg.meta.paperChart.mime};base64,${msg.meta.paperChart.pngBase64}`}
                      download={`${msg.meta.paperChart.title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 80)}.png`}
                      className="inline-flex rounded-md border border-[color:var(--t-br10)] bg-[var(--t-elevated)] px-2.5 py-1 text-[10px] font-medium text-[var(--t-text)] hover:bg-[var(--t-muted-hover)]"
                    >
                      下载 PNG
                    </a>
                  </div>
                </>
              ) : msg.meta.paperChart.svgBase64 ? (
                <>
                  <p className="mb-1 mt-2 text-[10px] text-[var(--t-text-dim)]">静态预览（SVG 散点图，纯JS渲染）</p>
                  <div
                    className="max-h-[min(72vh,720px)] w-full max-w-full overflow-auto rounded-lg border border-[color:var(--t-br08)] bg-white"
                    dangerouslySetInnerHTML={{ __html: (typeof atob === "function" ? atob : (s: string) => s)(msg.meta.paperChart.svgBase64) }}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href={`data:image/svg+xml;base64,${msg.meta.paperChart.svgBase64}`}
                      download={`${msg.meta.paperChart.title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 80)}.svg`}
                      className="inline-flex rounded-md border border-[color:var(--t-br10)] bg-[var(--t-elevated)] px-2.5 py-1 text-[10px] font-medium text-[var(--t-text)] hover:bg-[var(--t-muted-hover)]"
                    >
                      下载 SVG
                    </a>
                  </div>
                </>
              ) : null}
              {msg.meta.paperChart.spec && Object.keys(msg.meta.paperChart.spec).length > 0 ? (
                <details className="mt-2 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-surface)] px-2 py-1.5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[10px] font-semibold text-[var(--t-text-muted)] [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0">抽取数据 spec（JSON）· 点击展开或收起</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-md border qp-btn-accent rounded-md px-2 py-0.5 text-[9px]"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void navigator.clipboard.writeText(
                          JSON.stringify(msg.meta!.paperChart!.spec!, null, 2),
                        );
                      }}
                    >
                      一键复制
                    </button>
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[9px] text-[var(--t-text-dim)]">
                    {JSON.stringify(msg.meta.paperChart.spec, null, 2)}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {!msg.error && onFeedback ? (
        <div className="mt-3 border-t border-border-subtle/60 pt-3 text-xs text-[var(--t-text-feedback)]">
          <div className="flex flex-wrap items-center gap-2">
            <span>本次回答是否有帮助？</span>
            <button
              type="button"
              disabled={feedbackLock !== undefined}
              onClick={() => onFeedback(msg.id, 1)}
              className="qp-feedback-btn disabled:opacity-40"
            >
              满意 +1
            </button>
            <button
              type="button"
              disabled={feedbackLock !== undefined}
              onClick={() => setNegOpen((o) => !o)}
              className="qp-feedback-btn disabled:opacity-40"
            >
              不满意 −1
            </button>
          </div>
          {negOpen && feedbackLock === undefined ? (
            <div className="mt-3 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] p-3 text-[11px] text-[var(--t-text)]">
              <p className="mb-2 font-medium text-[var(--t-text-secondary)]">
                请告诉我们主要不满意在哪里（可多选），后续<strong className="text-[var(--t-text)]">文献综述</strong>会尽量弱化这些方面：
              </p>
              <div className="flex flex-col gap-1.5">
                {DISLIKE_ASPECTS.map((a) => (
                  <label key={a.id} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={negAspects.has(a.id)}
                      onChange={() => toggleNegAspect(a.id)}
                      className="mt-0.5 qp-accent-input"
                    />
                    <span>{a.label}</span>
                  </label>
                ))}
              </div>
              <label className="mt-2 block text-[10px] font-medium text-[var(--t-text-label)]">补充说明（可选）</label>
              <textarea
                value={negNote}
                onChange={(e) => setNegNote(e.target.value)}
                rows={2}
                maxLength={400}
                placeholder="例如：希望少引用综述、多给可执行步骤…"
                className="mt-1 w-full resize-y rounded-md border border-[color:var(--t-br10)] bg-[var(--t-surface)] px-2 py-1.5 text-[11px] text-[var(--t-text)] placeholder:text-[var(--t-placeholder-input)]"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void submitNegativeWithPrefs()}
                  className="qp-btn-accent rounded-md px-3 py-1.5 text-[11px]"
                >
                  提交不满意并调整后续风格
                </button>
                <button
                  type="button"
                  onClick={() => void submitNegativeSkipPrefs()}
                  className="rounded-md border border-[color:var(--t-br10)] px-3 py-1.5 text-[11px] text-[var(--t-text-muted)] hover:bg-[var(--t-muted)]"
                >
                  仅标记不满意，不调整后续
                </button>
                <button
                  type="button"
                  onClick={() => setNegOpen(false)}
                  className="rounded-md px-2 py-1.5 text-[11px] text-[var(--t-text-dim)] hover:text-[var(--t-text)]"
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LlmRewriteSettingsModal({
  open,
  urlDraft,
  keyDraft,
  modelDraft,
  onChangeUrl,
  onChangeKey,
  onChangeModel,
  onSave,
  onClear,
  onClose,
}: {
  open: boolean;
  urlDraft: string;
  keyDraft: string;
  modelDraft: string;
  onChangeUrl: (v: string) => void;
  onChangeKey: (v: string) => void;
  onChangeModel: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--t-overlay)] px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="llm-settings-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[min(520px,100%)] rounded-2xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] p-4 shadow-2xl shadow-[var(--t-modal-shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="llm-settings-dialog-title" className="text-[15px] font-semibold text-[var(--t-text-card-title)]">
          查询重写（LLM）
        </h2>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--t-text-faint)]">
          用于检索前的<strong className="text-[var(--t-text-muted)]">查询重写</strong>，以及检索完成后的<strong className="text-[var(--t-text-muted)]">文献综述</strong>（基于检索到的摘要，回答中标注 DOI / arXiv）。以下三项仅保存在本机（localStorage），检索时通过请求头传给同源后端；不会写入对话导出
          JSON。须为 <span className="font-mono text-[var(--t-text-dim)]">POST …/chat/completions</span> 的兼容接口。未填 URL 时由服务端{" "}
          <span className="font-mono text-[var(--t-text-dim)]">LLM_CHAT_COMPLETIONS_URL</span> 决定；若也未配置则默认{" "}
          <span className="font-mono text-[var(--t-text-dim)]">api.deepseek.com</span>（模型默认 deepseek-v4-flash，即 DeepSeek-V4-Flash）。可改为 OpenAI、通义、本地 Ollama 等，请保持
          Key 与 URL 一致。
        </p>
        <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-[var(--t-text-micro)]">
          Chat Completions URL（可选）
        </label>
        <input
          type="text"
          name="llm-chat-completions-url"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          value={urlDraft}
          onChange={(e) => onChangeUrl(e.target.value)}
          placeholder="留空则用 DeepSeek；或填 https://api.openai.com/v1/chat/completions 等"
          className="mt-1 w-full rounded-lg border border-[color:var(--t-br10)] bg-[var(--t-field)] px-3 py-2 font-mono text-[12px] text-[var(--t-text)] placeholder:text-[var(--t-placeholder-input)] qp-focus-accent border-[color:var(--t-br10)]"
        />
        <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-[var(--t-text-micro)]">
          API Key
        </label>
        <PasswordInputWithToggle
          name="llm-api-key"
          autoComplete="new-password"
          data-1p-ignore="true"
          data-lpignore="true"
          value={keyDraft}
          onChange={(e) => onChangeKey(e.target.value)}
          placeholder="sk-…"
          wrapperClassName="mt-1"
          className="w-full rounded-lg border border-[color:var(--t-br10)] bg-[var(--t-field)] px-3 py-2 font-mono text-[13px] text-[var(--t-text)] placeholder:text-[var(--t-placeholder-input)] qp-focus-accent border-[color:var(--t-br10)]"
        />
        <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-[var(--t-text-micro)]">
          模型（可选）
        </label>
        <input
          type="text"
          name="llm-model-id"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          value={modelDraft}
          onChange={(e) => onChangeModel(e.target.value)}
          placeholder="默认 deepseek-v4-flash（可填 deepseek-v4-pro、gpt-4o-mini…）"
          className="mt-1 w-full rounded-lg border border-[color:var(--t-br10)] bg-[var(--t-field)] px-3 py-2 text-[13px] text-[var(--t-text)] placeholder:text-[var(--t-placeholder-input)] qp-focus-accent border-[color:var(--t-br10)]"
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onSave}
            className="qp-btn-accent rounded-lg px-4 py-2 text-[13px] shadow-md"
          >
            保存
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-[color:var(--t-br12)] bg-transparent px-4 py-2 text-[13px] text-[var(--t-text-modal-muted)] hover:bg-[color:var(--t-br-hover05)]"
          >
            清除
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg px-3 py-2 text-[13px] text-[var(--t-text-close)] hover:text-[var(--t-text-close-hover)]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App({ onLogout }: { onLogout?: () => void } = {}) {
  const { theme, setTheme } = useTheme();
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const loaded = loadSessions(getAuthProfile()?.userId);
    return loaded.length ? loaded : [createSession()];
  });
  const [sessionsHydrated, setSessionsHydrated] = useState(false);
  const [sessionSyncState, setSessionSyncState] = useState<ChatSessionsSyncState | null>(null);
  const serverSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverSaveInflightRef = useRef<Promise<void> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [input, setInput] = useState("");
  const [queryField, setQueryField] = useState<ArxivSearchField>("ti");
  const [searchChannel, setSearchChannel] = useState<SearchChannel>("web");
  const [searchSort, setSearchSort] = useState<PaperSortKey>("relevance");
  /** 仅专利：OpenAlex 专利 + 专利网页，结果带 patentNumber */
  const [patentsOnlyEnabled, setPatentsOnlyEnabled] = useState(false);
  /** 勾选后：服务端对命中 PDF 逐篇下载 → MinerU → 三模型抽词 → 深度综合（耗时长） */
  const [deepMineEnabled, setDeepMineEnabled] = useState(false);
  /** 深度解析发送后短暂提示，数秒后自动消失 */
  const [deepMineToast, setDeepMineToast] = useState<string | null>(null);
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, 1 | -1>>({});
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  /** 单会话：在对话里勾选后的子集；null = 导出该会话全部 */
  const [partialExportBySession, setPartialExportBySession] = useState<{
    sessionId: string;
    ids: Set<string>;
  } | null>(null);
  const [exportPickMode, setExportPickMode] = useState(false);
  const [personaList, setPersonaList] = useState(DEFAULT_PERSONA_LIST);
  const [personaId, setPersonaIdState] = useState(() => getPersonaId());
  const [exportPickSessionId, setExportPickSessionId] = useState<string | null>(null);
  const [exportPickSelected, setExportPickSelected] = useState<Record<string, boolean>>({});
  /** 正在为某条助手消息生成 Matplotlib 图（防重复点击） */
  const [chartBusyMessageId, setChartBusyMessageId] = useState<string | null>(null);
  const [dataTableBusyMessageId, setDataTableBusyMessageId] = useState<string | null>(null);
  const [pptxBusyMessageId, setPptxBusyMessageId] = useState<string | null>(null);
  const [flowBusyMessageId, setFlowBusyMessageId] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [llmClientHint, setLlmClientHint] = useState(
    () => !!(getOpenAiKey() || getLlmChatCompletionsUrl()),
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pointBalance, setPointBalance] = useState<PointBalance | null>(() => getAuthProfile()?.billing ?? null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [pdfBusyKey, setPdfBusyKey] = useState<string | null>(null);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );
  const activeAssistantShowsProgress = useMemo(() => {
    if (!busy || !active?.messages.length) return false;
    const last = active.messages[active.messages.length - 1];
    if (last.role !== "assistant" || last.error) return false;
    return /^synth:(pending|streaming|replaced)$/i.test(String(last.meta?.synthesisNote ?? ""));
  }, [active?.messages, busy]);

  const exportPickCounts = useMemo(() => {
    if (!exportPickMode || !exportPickSessionId) return { total: 0, picked: 0 };
    const s = sessions.find((x) => x.id === exportPickSessionId);
    if (!s) return { total: 0, picked: 0 };
    const picked = s.messages.filter((m) => exportPickSelected[m.id]).length;
    return { total: s.messages.length, picked };
  }, [exportPickMode, exportPickSessionId, sessions, exportPickSelected]);

  /** 整页刷新时重新挂载 App，惰性初始化会重新随机；同一次访问内切换会话不换句 */
  const [emptyWelcome] = useState(() => pickWelcomeCopy());

  useEffect(() => {
    void fetchPersonaList().then(setPersonaList);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchPointBalance()
      .then(({ billing, pricing: nextPricing }) => {
        if (cancelled) return;
        setPointBalance(billing);
        if (nextPricing) setPricing(nextPricing);
        setBalanceError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          clearAuthSession();
          onLogout?.();
          return;
        }
        setBalanceError(e instanceof Error ? e.message : "积分余额加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [onLogout]);

  const applyReceipt = useCallback((receipt?: BillingReceipt | null) => {
    if (!receipt) return;
    setPointBalance((prev) => ({
      userId: prev?.userId,
      balanceUnits: receipt.balanceUnits,
      availableUnits: receipt.balanceUnits,
      balance: receipt.balance,
    }));
    setBalanceError(null);
  }, []);

  useEffect(() => {
    if (!deepMineToast) return;
    const id = window.setTimeout(() => setDeepMineToast(null), 4200);
    return () => window.clearTimeout(id);
  }, [deepMineToast]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (mq.matches) setMobileNavOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      if (!getAuthToken()) {
        if (!cancelled) setSessionsHydrated(true);
        return;
      }
      const local = loadSessions(getAuthProfile()?.userId);
      const remote = await fetchChatSessionsFromServer();
      if (cancelled) return;
      if (remote) {
        if (remote.sessions.length > 0 || local.length > 0) {
          const merged = mergeChatSessions(local, remote.sessions);
          setSessions(merged.length ? merged : [createSession()]);
          saveSessions(merged, getAuthProfile()?.userId);
        }
        setSessionSyncState({
          revision: remote.revision,
          schemaVersion: remote.schemaVersion,
          updatedAt: remote.updatedAt,
        });
      }
      setSessionsHydrated(true);
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionsHydrated) return;
    try {
      saveSessions(sessions, getAuthProfile()?.userId);
    } catch (e) {
      console.warn("[App] saveSessions effect failed, skipped", e);
    }
    if (!getAuthToken()) return;
    if (serverSaveTimerRef.current) clearTimeout(serverSaveTimerRef.current);
    serverSaveTimerRef.current = setTimeout(() => {
      // Guard: don't start a new PUT while one is already in flight
      if (serverSaveInflightRef.current) return;
      const baseRevision = sessionSyncState?.revision ?? null;
      const payload = sessionsPayloadForServer(sessions);
      const doSave = async (): Promise<void> => {
        const result = await saveChatSessionsToServer(payload, undefined, baseRevision);
        if (result.ok) {
          if (typeof result.revision === "number") {
            setSessionSyncState((prev) => ({
              revision: result.revision!,
              schemaVersion: prev?.schemaVersion ?? 1,
              updatedAt: result.updatedAt ?? Date.now(),
            }));
          }
        } else if (result.conflict) {
          console.warn("[App] chat sessions conflict (409); merging and retrying", {
            serverRevision: result.revision,
          });
          const serverSessions = Array.isArray(result.sessions) ? result.sessions : [];
          const merged = mergeChatSessions(serverSessions, sessions);
          setSessions(merged.length ? merged : [createSession()]);
          saveSessions(merged, getAuthProfile()?.userId);
          // Retry once with the server's revision
          const retryRevision = result.revision ?? 0;
          const retryResult = await saveChatSessionsToServer(
            sessionsPayloadForServer(merged),
            undefined,
            retryRevision,
          );
          if (retryResult.ok && typeof retryResult.revision === "number") {
            setSessionSyncState((prev) => ({
              revision: retryResult.revision!,
              schemaVersion: prev?.schemaVersion ?? 1,
              updatedAt: retryResult.updatedAt ?? Date.now(),
            }));
          }
        }
      };
      serverSaveInflightRef.current = doSave().finally(() => {
        serverSaveInflightRef.current = null;
      });
    }, 1200);
    return () => {
      if (serverSaveTimerRef.current) clearTimeout(serverSaveTimerRef.current);
    };
  }, [sessions, sessionsHydrated, sessionSyncState]);

  useLayoutEffect(() => {
    setActiveId((id) => {
      if (id && sessions.some((s) => s.id === id)) return id;
      return sessions[0]?.id ?? null;
    });
  }, [sessions]);

  useLayoutEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
  }, []);

  useEffect(() => {
    const msgs = active?.messages;
    if (!msgs?.length) return;
    const last = msgs[msgs.length - 1];
    /** 仅在用户刚发出消息时滚到底部；助手答案到达或流式更新时不自动滚，避免打断阅读 */
    if (last.role === "user") scrollToBottom();
  }, [active?.messages, scrollToBottom]);

  const openExportModal = useCallback(() => {
    setPartialExportBySession(null);
    setExportPickMode(false);
    setExportPickSessionId(null);
    setExportPickSelected({});
    setExportModalOpen(true);
  }, []);

  const closeExportModal = useCallback(() => {
    setExportModalOpen(false);
    setPartialExportBySession(null);
  }, []);

  const clearPartialExport = useCallback(() => {
    setPartialExportBySession(null);
  }, []);

  const startExportPickMessages = useCallback(
    (sessionId: string) => {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) return;
      const sel: Record<string, boolean> = {};
      for (const m of s.messages) sel[m.id] = true;
      setExportPickSelected(sel);
      setExportPickSessionId(sessionId);
      setExportPickMode(true);
      setExportModalOpen(false);
      if (activeId !== sessionId) {
        setActiveId(sessionId);
        setInput("");
        setAttachments([]);
      }
    },
    [sessions, activeId],
  );

  const toggleExportPickMessage = useCallback((messageId: string) => {
    setExportPickSelected((p) => ({ ...p, [messageId]: !p[messageId] }));
  }, []);

  const setExportPickAll = useCallback(
    (on: boolean) => {
      if (!exportPickSessionId) return;
      const s = sessions.find((x) => x.id === exportPickSessionId);
      if (!s) return;
      const sel: Record<string, boolean> = {};
      for (const m of s.messages) sel[m.id] = on;
      setExportPickSelected(sel);
    },
    [exportPickSessionId, sessions],
  );

  const finishExportPick = useCallback(() => {
    if (!exportPickSessionId) return;
    const s = sessions.find((x) => x.id === exportPickSessionId);
    if (!s) {
      setExportPickMode(false);
      setExportPickSessionId(null);
      setExportPickSelected({});
      return;
    }
    const picked = s.messages.filter((m) => exportPickSelected[m.id]);
    if (picked.length === 0) {
      window.alert("请至少勾选一条消息");
      return;
    }
    const all = picked.length === s.messages.length;
    setPartialExportBySession(
      all ? null : { sessionId: exportPickSessionId, ids: new Set(picked.map((m) => m.id)) },
    );
    setExportPickMode(false);
    setExportPickSessionId(null);
    setExportPickSelected({});
    setExportModalOpen(true);
  }, [exportPickSessionId, exportPickSelected, sessions]);

  const cancelExportPick = useCallback(() => {
    setExportPickMode(false);
    setExportPickSessionId(null);
    setExportPickSelected({});
    setExportModalOpen(true);
  }, []);

  useEffect(() => {
    if (!exportPickMode || !exportPickSessionId) return;
    const s = sessions.find((x) => x.id === exportPickSessionId);
    if (!s) return;
    setExportPickSelected((prev) => {
      const next = { ...prev };
      for (const m of s.messages) {
        if (!(m.id in next)) next[m.id] = true;
      }
      return next;
    });
  }, [exportPickMode, exportPickSessionId, sessions]);

  useEffect(() => {
    if (!exportPickMode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") cancelExportPick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportPickMode, cancelExportPick]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      if (apiKeyModalOpen || exportModalOpen) return;
      e.preventDefault();
      setHistorySearchOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apiKeyModalOpen, exportModalOpen]);

  const newChat = () => {
    if (exportPickMode) {
      if (!window.confirm("新建对话将取消正在进行的导出勾选，是否继续？")) return;
      setExportPickMode(false);
      setExportPickSessionId(null);
      setExportPickSelected({});
    }
    const s = createSession();
    activeIdRef.current = s.id;
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setInput("");
    setAttachments([]);
    setMobileNavOpen(false);
  };

  const selectSession = (id: string) => {
    if (exportPickMode && id !== exportPickSessionId) {
      if (!window.confirm("切换会话将取消正在进行的导出勾选，是否继续？")) return;
      setExportPickMode(false);
      setExportPickSessionId(null);
      setExportPickSelected({});
    }
    activeIdRef.current = id;
    setActiveId(id);
    setInput("");
    setAttachments([]);
    setMobileNavOpen(false);
  };

  const jumpToHistory = useCallback(
    (sessionId: string, messageId: string | null) => {
      if (exportPickMode && sessionId !== exportPickSessionId) {
        if (!window.confirm("切换会话将取消正在进行的导出勾选，是否继续？")) return;
        setExportPickMode(false);
        setExportPickSessionId(null);
        setExportPickSelected({});
      }
      activeIdRef.current = sessionId;
      setActiveId(sessionId);
      setInput("");
      setAttachments([]);
      setMobileNavOpen(false);
      setHistorySearchOpen(false);
      if (messageId) {
        window.setTimeout(() => {
          document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 120);
      }
    },
    [exportPickMode, exportPickSessionId],
  );

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const processSelectedFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploadNotice(null);
    setUploadError(null);
    setUploadBusy(true);
    const added: UploadedAttachment[] = [];
    try {
      for (const f of files) {
        setUploadingFileName(f.name);
        const r = await extractUploadedDocument(f);
        const item: UploadedAttachment = {
          id: uid(),
          name: r.filename || f.name,
          text: r.text,
          chars: r.charCount,
        };
        added.push(item);
        setAttachments((prev) => [...prev, item]);
      }
      if (added.length) {
        const totalChars = added.reduce((n, a) => n + a.chars, 0);
        const names = added.map((a) => a.name).join("、");
        setUploadNotice(
          added.length === 1
            ? `已上传「${names}」· ${totalChars.toLocaleString()} 字，发送时将一并分析`
            : `已上传 ${added.length} 个文件（${names}）· 共 ${totalChars.toLocaleString()} 字`,
        );
        window.setTimeout(() => setUploadNotice(null), 5000);
      }
    } catch (err) {
      setUploadNotice(null);
      const msg = err instanceof Error ? err.message : "文件解析失败";
      setUploadError(msg);
    } finally {
      setUploadBusy(false);
      setUploadingFileName(null);
    }
  };

  const onFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    e.target.value = "";
    if (!list?.length) return;
    void processSelectedFiles(Array.from(list));
  };

  const onUploadDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (uploadBusy || exportPickMode) return;
    const files = e.dataTransfer.files;
    if (!files?.length) return;
    void processSelectedFiles(Array.from(files));
  };

  const deleteSession = (id: string, e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeId && next[0]) setActiveId(next[0].id);
      if (!next.length) {
        const s = createSession();
        setActiveId(s.id);
        return [s];
      }
      return next;
    });
  };

  const patchMessageMeta = useCallback((msgId: string, patch: Record<string, unknown>) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (!s.messages.some((m) => m.id === msgId)) return s;
        return {
          ...s,
          messages: s.messages.map((m) =>
            m.id === msgId ? { ...m, meta: { ...(m.meta ?? {}), ...patch } } : m,
          ),
          updatedAt: Date.now(),
        };
      }),
    );
  }, []);

  const handleFeedback = async (messageId: string, value: 1 | -1, detail?: AssistantFeedbackDetail) => {
    const m = active?.messages.find((x) => x.id === messageId);
    try {
      if (value === -1 && detail && !detail.skipPreference) {
        const aspects = detail.aspects?.length ? detail.aspects : [];
        const note = detail.note?.trim();
        if (aspects.length || (note && note.length >= 3)) {
          addDissatisfactionEntry({ aspects, note });
        }
      }
      await submitFeedback({
        messageId,
        value,
        channel: m?.meta?.channel ?? searchChannel,
      });
      setFeedbackByMessage((prev) => ({ ...prev, [messageId]: value }));
    } catch {
      /* 忽略网络错误，不打断聊天 */
    }
  };

  const handleMatplotlibChart = useCallback(async (msg: ChatMessage, hint?: string) => {
    if (!msg.papers?.length || msg.error || !channelSupportsPaperChart(msg.meta?.channel)) return;
    const parentOperationId = msg.meta?.parentOperationId ?? msg.meta?.billing?.operationId;
    if (!parentOperationId) {
      patchMessageMeta(msg.id, { paperChartError: "此历史回答缺少搜索操作 ID，无法生成收费图表，请重新检索。" });
      return;
    }
    if (pointBalance && pointBalance.balance <= 0) {
      patchMessageMeta(msg.id, { paperChartError: `积分已用完（当前余额 ${formatPoints(pointBalance.balance)}），请充值后继续使用。` });
      return;
    }
    const idempotencyKey = createIdempotencyKey();
    setChartBusyMessageId(msg.id);
    const errText = (e: unknown) => (e instanceof Error ? e.message : "生成图表失败");
    const patchMsg = (m: ChatMessage, patch: Record<string, unknown>) => ({
      ...m,
      meta: { ...(m.meta ?? {}), ...patch },
    });
    setSessions((prev) =>
      prev.map((s) => {
        if (!s.messages.some((x) => x.id === msg.id)) return s;
        return {
          ...s,
          messages: s.messages.map((m) => (m.id === msg.id ? patchMsg(m, { paperChartError: null }) : m)),
          updatedAt: Date.now(),
        };
      }),
    );
    try {
      const r = await requestPaperChartFromPapers(msg.papers, {
        parentOperationId,
        hint,
        synthesisMarkdown: msg.meta?.synthesis ?? undefined,
        idempotencyKey,
      });
      applyReceipt(r.billing);
      setSessions((prev) =>
        prev.map((s) => {
          if (!s.messages.some((m) => m.id === msg.id)) return s;
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id !== msg.id
                ? m
                : patchMsg(m, {
                    paperChartError: null,
                    paperChart: {
                      mime: r.mime,
                      pngBase64: r.pngBase64,
                      svgBase64: r.svgBase64,
                      title: r.title,
                      spec: r.spec,
                      note: r.note,
                      billing: r.billing,
                    },
                  }),
            ),
            updatedAt: Date.now(),
          };
        }),
      );
    } catch (e) {
      const msgText = errText(e);
      setSessions((prev) =>
        prev.map((s) => {
          if (!s.messages.some((x) => x.id === msg.id)) return s;
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === msg.id ? patchMsg(m, { paperChartError: msgText }) : m,
            ),
            updatedAt: Date.now(),
          };
        }),
      );
    } finally {
      setChartBusyMessageId(null);
    }
  }, [applyReceipt, patchMessageMeta, pointBalance?.balance]);

  const handleGenerateDataTable = useCallback(async (msg: ChatMessage, tableType: DataTablePresetId) => {
    if (!msg.papers?.length || msg.error || !channelSupportsPaperChart(msg.meta?.channel)) return;
    setDataTableBusyMessageId(msg.id);
    const patchMeta = (patch: Record<string, unknown>) => ({
      ...msg,
      meta: { ...(msg.meta ?? {}), ...patch },
    });
    setSessions((prev) =>
      prev.map((s) => {
        if (!s.messages.some((m) => m.id === msg.id)) return s;
        return {
          ...s,
          messages: s.messages.map((m) =>
            m.id === msg.id ? patchMeta({ dataTableError: null, activeDataTableType: tableType }) : m,
          ),
          updatedAt: Date.now(),
        };
      }),
    );
    try {
      const r = await requestGenerateDataTable(msg.papers, tableType, {
        synthesisMarkdown: msg.meta?.synthesis ?? undefined,
      });
      setSessions((prev) =>
        prev.map((s) => {
          if (!s.messages.some((m) => m.id === msg.id)) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== msg.id) return m;
              const prevTables = { ...(m.meta?.dataTables ?? {}) };
              prevTables[tableType] = {
                tableType: r.tableType,
                title: r.title,
                rows: r.rows,
                note: r.note,
                generatedAt: Date.now(),
              };
              return patchMeta({
                dataTables: prevTables,
                dataTableError: null,
                activeDataTableType: tableType,
              });
            }),
            updatedAt: Date.now(),
          };
        }),
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "生成数据表失败";
      setSessions((prev) =>
        prev.map((s) => {
          if (!s.messages.some((m) => m.id === msg.id)) return s;
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === msg.id ? patchMeta({ dataTableError: errMsg }) : m,
            ),
            updatedAt: Date.now(),
          };
        }),
      );
    } finally {
      setDataTableBusyMessageId(null);
    }
  }, []);

  const handleBuildFlowchart = useCallback(
    async (msg: ChatMessage) => {
      if (!msg.meta?.synthesis?.trim() && !msg.meta?.synthesisPlan) return;
      setFlowBusyMessageId(msg.id);
      patchMessageMeta(msg.id, { artifactError: null });
      try {
        const r = await requestFlowchartArtifact({
          synthesisMarkdown: msg.meta?.synthesis ?? undefined,
          synthesisPlan: msg.meta?.synthesisPlan ?? undefined,
          title: msg.meta?.effectiveQuery ?? undefined,
          query: msg.meta?.effectiveQuery ?? undefined,
        });
        patchMessageMeta(msg.id, {
          artifacts: {
            flowchart: {
              mermaid: r.mermaid,
              steps: r.steps,
              recipeLines: r.recipeLines,
              svgBase64: r.svgBase64,
              title: r.title,
            },
            note: r.note,
            stepCount: Array.isArray(r.steps) ? r.steps.length : 0,
          },
          artifactError: null,
        });
      } catch (e) {
        patchMessageMeta(msg.id, {
          artifactError: e instanceof Error ? e.message : "流程图生成失败",
        });
      } finally {
        setFlowBusyMessageId(null);
      }
    },
    [patchMessageMeta],
  );

  const handleDownloadPptx = useCallback(
    async (msg: ChatMessage) => {
      if (!msg.meta?.synthesis?.trim() && !msg.meta?.synthesisPlan) return;
      setPptxBusyMessageId(msg.id);
      patchMessageMeta(msg.id, { artifactError: null });
      try {
        const title = (msg.meta?.effectiveQuery ?? "方案汇报").replace(/[^\w\u4e00-\u9fa5.-]+/g, "_").slice(0, 48);
        const blob = await downloadPptxArtifact({
          synthesisMarkdown: msg.meta?.synthesis ?? undefined,
          synthesisPlan: msg.meta?.synthesisPlan ?? undefined,
          title: msg.meta?.effectiveQuery ?? undefined,
          query: msg.meta?.effectiveQuery ?? undefined,
        });
        saveAs(blob, `${title || "report"}.pptx`);
      } catch (e) {
        patchMessageMeta(msg.id, {
          artifactError: e instanceof Error ? e.message : "PPT 生成失败",
        });
      } finally {
        setPptxBusyMessageId(null);
      }
    },
    [patchMessageMeta],
  );

  const handlePdfFulfill = useCallback(async (msg: ChatMessage, p: Paper, mode: "open" | "save") => {
    const parentOperationId = msg.meta?.parentOperationId ?? msg.meta?.billing?.operationId;
    if (!parentOperationId) {
      window.alert("此历史回答缺少搜索操作 ID，无法获取收费 PDF，请重新检索。");
      return;
    }
    if (pointBalance && pointBalance.balance <= 0) {
      window.alert(`积分已用完（当前余额 ${formatPoints(pointBalance.balance)}），请充值后继续使用。`);
      return;
    }
    const busyKey = `${msg.id}:${paperRowKey(p)}`;
    if (pdfBusyKey === busyKey) return;
    const idempotencyKey = createIdempotencyKey();
    setPdfBusyKey(busyKey);
    try {
      const result = await fulfillPdf({
        parentOperationId,
        paperId: p.paper_id || p.id,
        sourceId: p.pdfSourceId ?? p.sourceId,
        idempotencyKey,
      });
      applyReceipt(result.receipt);
      if (result.receipt) {
        patchMessageMeta(msg.id, {
          pdfReceipts: [...(msg.meta?.pdfReceipts ?? []), result.receipt],
        });
      }
      const filename = result.filename || safePdfDownloadName(p);
      if (mode === "save") {
        saveAs(result.blob, filename);
      } else {
        const objectUrl = URL.createObjectURL(result.blob);
        window.open(objectUrl, "_blank", "noopener,noreferrer");
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "PDF 获取失败";
      window.alert(message);
      if (e instanceof ApiError && e.balance) setPointBalance(e.balance);
    } finally {
      setPdfBusyKey(null);
    }
  }, [applyReceipt, patchMessageMeta, pdfBusyKey, pointBalance?.balance]);

  const send = async (text: string) => {
    const q = text.trim();
    const attachLine =
      attachments.length > 0 ? `\n📎 ${attachments.map((a) => a.name).join("、")}` : "";
    if ((!q && attachments.length === 0) || !activeId || busy) return;

    const sessionId = activeIdRef.current ?? activeId;
    if (!sessionId) return;

    const priorMessages = sessions.find((s) => s.id === sessionId)?.messages ?? [];

    const userDisplay = (q || "（仅上传文件作为上下文）") + attachLine;
    const userMsg: ChatMessage = { id: uid(), role: "user", content: userDisplay };
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: [...s.messages, userMsg],
              title: s.messages.length === 0 ? sessionTitleFromMessages([userMsg]) : s.title,
              updatedAt: Date.now(),
            }
          : s,
      ),
    );
    setInput("");
    setBusy(true);
    if (deepMineEnabled && !patentsOnlyEnabled) {
      setDeepMineToast("已启用深度解析：将逐篇下载 PDF 并解析，可能需较长时间");
    }
    const fieldAtSend = queryField;
    const channelAtSend = searchChannel;
    const sortAtSend = searchSort;
    const patentsAtSend = patentsOnlyEnabled;
    const attachmentContext =
      attachments.length > 0
        ? attachments.map((a) => `《${a.name}》\n${a.text}`).join("\n\n---\n\n").slice(0, 200_000)
        : undefined;
    const attachmentFilename =
      attachments.length > 0 ? attachments.map((a) => a.name).join("、").slice(0, 512) : undefined;
    const conversationContext =
      priorMessages.length > 0
        ? buildSearchContextFromMessages(priorMessages, 4800, channelAtSend)
        : "";
    const baseQ =
      q ||
      (channelAtSend === "web"
        ? "根据上传文件中的主题与关键词进行全网搜索并综合回答"
        : "根据上传文件中的主题与关键词搜索相关资料");
    try {
      const searchIdempotencyKey = createIdempotencyKey();

      // ── 流式模式：papers 立即到达，synthesis token 逐字追加 ──
      const abortController = new AbortController();
      const streamOpts = {
        idempotencyKey: searchIdempotencyKey,
        field: fieldAtSend,
        channel: channelAtSend,
        sort: sortAtSend,
        attachmentContext,
        attachmentFilename,
        conversationContext: conversationContext || undefined,
        ...(patentsAtSend ? { patentsOnly: true } : {}),
        ...(deepMineEnabled && !patentsAtSend ? { deepMine: { maxPdfMb: 20 } } : {}),
        signal: abortController.signal,
      };

      // 占位助手消息（papers 到达前先显示空卡片）
      const assistantId = uid();
      let papersReceived: Paper[] = [];
      let synthesisSoFar = "";

      const upsertAssistant = (patch: Partial<ChatMessage>) => {
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const idx = s.messages.findIndex((m) => m.id === assistantId);
            if (idx === -1) {
              // 第一次：追加
              const newMsg: ChatMessage = {
                id: assistantId,
                role: "assistant",
                content: "",
                papers: papersReceived,
                arxivField: fieldAtSend,
                meta: {
                  channel: channelAtSend,
                  sort: sortAtSend,
                  synthesis: synthesisSoFar || null,
                },
                ...patch,
              };
              return {
                ...s,
                messages: [...s.messages, newMsg],
                title: sessionTitleFromMessages([...s.messages, newMsg]),
                updatedAt: Date.now(),
              };
            }
            // 更新现有；meta 做深合并，避免逐 token 更新时丢失 papers 事件写入的字段
            const updated = {
              ...s.messages[idx],
              ...patch,
              ...(patch.meta
                ? { meta: { ...(s.messages[idx].meta ?? {}), ...patch.meta } }
                : {}),
            };
            const msgs = [...s.messages];
            msgs[idx] = updated;
            return { ...s, messages: msgs, updatedAt: Date.now() };
          }),
        );
      };

      let streamErrored = false;

      for await (const event of searchPapersV1Stream(baseQ.slice(0, 12_000), streamOpts)) {
        if (event.type === "papers") {
          papersReceived = event.papers ?? [];
          upsertAssistant({
            papers: papersReceived,
            meta: {
              effectiveQuery: event.effectiveQuery,
              rewriteNote: event.rewriteNote,
              queryIntent: event.queryIntent ?? null,
              sourcesUsed: event.sourcesUsed,
              channel: event.channel ?? channelAtSend,
              sort: event.sort ?? sortAtSend,
              latencyMs: event.latencySearch,
              patentsOnly: event.patentsOnly ?? false,
              synthesis: null,
              synthesisNote: "synth:pending",
              synthesisPlan: null,
              persona: event.persona,
              personaLabel: event.personaLabel,
            },
          });
        } else if (event.type === "synthesis_token") {
          synthesisSoFar += event.token;
          // 联网 C-preview 直接展示 SSE 片段，不再叠加前端打字动画。
          upsertAssistant({
            meta: {
              // 保留已有 meta，只更新 synthesis
              channel: channelAtSend,
              sort: sortAtSend,
              synthesis: synthesisSoFar,
              synthesisNote: "synth:streaming",
            },
          });
        } else if (event.type === "synthesis_replace") {
          synthesisSoFar = event.synthesis;
          upsertAssistant({
            meta: {
              channel: channelAtSend,
              sort: sortAtSend,
              synthesis: synthesisSoFar,
              synthesisNote: "synth:replaced",
            },
          });
        } else if (event.type === "points_exhausted") {
          upsertAssistant({
            meta: {
              channel: channelAtSend,
              sort: sortAtSend,
              synthesis: synthesisSoFar,
              synthesisNote: "synth:points_exhausted",
              pointsExhausted: true,
              billingMessage: event.message,
            },
          });
        } else if (event.type === "done") {
          if (event.billingReceipt) applyReceipt(event.billingReceipt);
          upsertAssistant({
            meta: {
              channel: channelAtSend,
              sort: sortAtSend,
              synthesis: (event.synthesis ?? synthesisSoFar) || null,
              synthesisNote: event.synthesisNote ?? null,
              pointsExhausted: event.pointsExhausted ?? false,
              billingMessage: event.billingMessage,
              synthesisPlan: event.synthesisPlan ?? null,
              synthesisPlanNote: event.synthesisPlanNote ?? null,
              synthesisModels: event.synthesisModels ?? null,
              webAnswerDrafts: event.webAnswerDrafts,
              rewriteNote: event.rewriteNote,
              sourcesUsed: event.sourcesUsed,
              latencyMs: event.latencyMs,
              performanceTrace: event.performanceTrace ?? null,
              parentOperationId: event.parentOperationId,
              billing: event.billingReceipt ?? null,
              deepMine: event.deepMine ?? null,
              deepSynthesis: event.deepSynthesis ?? null,
              deepSynthesisNote: event.deepSynthesisNote ?? null,
            },
          });
        } else if (event.type === "error") {
          streamErrored = true;
          upsertAssistant({ content: event.error, error: true, meta: { synthesisNote: "synth:error" } });
        }
      }

      if (streamErrored) {
        // error 已经显示，无需额外处理
      }

      setAttachments([]);

      // 自动作图（复用非流式逻辑）
      const assistantIdForChart = assistantId;
      const papersForAutoChart = papersReceived;
      // parentOperationId 由 done 事件携带，已写入 meta；此处仅处理余额不足提示
      if (
        papersForAutoChart.length > 0 &&
        channelSupportsPaperChart(channelAtSend) &&
        (pointBalance?.balance ?? 0) <= 0
      ) {
        patchMessageMeta(assistantIdForChart, {
          paperChartError: "搜索结算后余额不足，未自动生成图表。",
        });
      }
    } catch (e) {
      if (e instanceof ApiError && e.balance) setPointBalance(e.balance);
      const err = e instanceof Error ? e.message : "未知错误";
      // 流式模式下，若之前已经推送了占位消息，直接更新为错误；否则新增错误消息
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const hasPlaceholder = s.messages.some((m) => m.role === "assistant" && !m.error && m.content === "");
          if (hasPlaceholder) {
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.role === "assistant" && !m.error && m.content === ""
                  ? { ...m, content: err, error: true }
                  : m,
              ),
              updatedAt: Date.now(),
            };
          }
          const assistant: ChatMessage = {
            id: uid(),
            role: "assistant",
            content: err,
            error: true,
            arxivField: fieldAtSend,
            meta: { channel: channelAtSend, sort: sortAtSend },
          };
          return { ...s, messages: [...s.messages, assistant], updatedAt: Date.now() };
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const willAttachConvoContext = (active?.messages.length ?? 0) > 0;

  const billingDisabled = pointBalance != null && pointBalance.balance <= 0;
  const canSend =
    (input.trim().length > 0 || attachments.length > 0) &&
    !busy &&
    !uploadBusy &&
    !exportPickMode &&
    !billingDisabled;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void send(input);
    }
  };

  return (
    <>
      {deepMineToast ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-[5.25rem] left-1/2 z-[120] max-w-[min(92vw,22rem)] -translate-x-1/2 rounded-xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] px-3 py-2 text-center text-[12px] leading-snug text-[var(--t-text)] shadow-lg shadow-[var(--t-modal-shadow)] sm:bottom-[5.5rem]"
        >
          {deepMineToast}
        </div>
      ) : null}
      {uploadBusy || uploadError || (uploadNotice && attachments.length > 0) ? (
        <div
          role="status"
          aria-live="assertive"
          className={`pointer-events-none fixed bottom-[6.5rem] left-1/2 z-[125] max-w-[min(92vw,24rem)] -translate-x-1/2 rounded-xl border px-3 py-2 text-center text-[12px] leading-snug shadow-lg sm:bottom-[7rem] ${
            uploadError
              ? "border-red-500/40 bg-red-950/90 text-red-100"
              : uploadBusy
                ? "border-[color:var(--t-br10)] bg-[var(--t-modal)] text-[var(--t-text)]"
                : "border-[color:var(--t-br10)] bg-[var(--t-elevated)] text-[var(--t-text)]"
          }`}
        >
          {uploadError
            ? uploadError
            : uploadBusy
              ? `正在解析${uploadingFileName ? `「${uploadingFileName}」` : "文件"}…`
              : uploadNotice}
        </div>
      ) : null}
      <ExportChatModal
        open={exportModalOpen}
        sessions={sessions}
        activeId={activeId}
        partialExport={partialExportBySession}
        onClose={closeExportModal}
        onClearPartialExport={clearPartialExport}
        onStartPickMessages={startExportPickMessages}
      />
      <HistorySearchModal
        open={historySearchOpen}
        sessions={sessions}
        activeSessionId={activeId}
        onClose={() => setHistorySearchOpen(false)}
        onSelect={jumpToHistory}
      />
      <LlmRewriteSettingsModal
        open={apiKeyModalOpen}
        urlDraft={urlDraft}
        keyDraft={keyDraft}
        modelDraft={modelDraft}
        onChangeUrl={setUrlDraft}
        onChangeKey={setKeyDraft}
        onChangeModel={setModelDraft}
        onSave={() => {
          setLlmChatCompletionsUrl(urlDraft);
          setOpenAiKey(keyDraft);
          setOpenAiModel(modelDraft);
          setLlmClientHint(!!(getOpenAiKey() || getLlmChatCompletionsUrl()));
          setApiKeyModalOpen(false);
        }}
        onClear={() => {
          clearLlmChatCompletionsUrl();
          clearOpenAiKey();
          clearOpenAiModel();
          setUrlDraft("");
          setKeyDraft("");
          setModelDraft("");
          setLlmClientHint(false);
        }}
        onClose={() => setApiKeyModalOpen(false)}
      />
      {exportPickMode && exportPickSessionId ? (
        <div
          className="fixed inset-x-0 bottom-[min(11rem,42vh)] z-[105] flex justify-center px-3 pointer-events-none sm:bottom-36"
          role="toolbar"
          aria-label="导出消息选择"
        >
          <div className="pointer-events-auto flex max-w-lg flex-col gap-2 rounded-xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] px-3 py-2.5 shadow-2xl shadow-[var(--t-modal-shadow)] sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
            <span className="text-[12px] font-medium text-[var(--t-text)]">
              选择要导出的消息
              <span className="ml-1.5 font-mono text-[11px] text-[var(--t-text-muted)]">
                {exportPickCounts.picked}/{exportPickCounts.total}
              </span>
            </span>
            <div className="flex flex-wrap gap-1.5 sm:ml-auto">
              <button
                type="button"
                onClick={() => setExportPickAll(true)}
                className="rounded-md border border-[color:var(--t-br08)] px-2 py-1 text-[11px] text-[var(--t-text-muted)] hover:bg-[color:var(--t-br-hover05)]"
              >
                全选
              </button>
              <button
                type="button"
                onClick={() => setExportPickAll(false)}
                className="rounded-md border border-[color:var(--t-br08)] px-2 py-1 text-[11px] text-[var(--t-text-muted)] hover:bg-[color:var(--t-br-hover05)]"
              >
                全不选
              </button>
              <button
                type="button"
                onClick={finishExportPick}
                className="qp-btn-accent rounded-md px-3 py-1 text-[11px]"
              >
                完成选择
              </button>
              <button
                type="button"
                onClick={cancelExportPick}
                className="rounded-md px-2 py-1 text-[11px] text-[var(--t-text-close)] hover:text-[var(--t-text-close-hover)]"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex h-full min-h-0 font-sans bg-[var(--t-page)]">
      {mobileNavOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px] transition-opacity lg:hidden"
          aria-label="关闭菜单"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-50 flex w-[min(292px,88vw)] flex-col border-r border-[color:var(--t-br06)] bg-[var(--t-sidebar)] shadow-[2px_0_12px_rgba(0,0,0,0.08)] transition-transform duration-200 ease-out lg:relative lg:z-auto lg:w-[272px] lg:shrink-0 lg:translate-x-0 lg:shadow-none",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        ].join(" ")}
      >
        <div className="qp-app-header-safe flex items-center gap-3 border-b border-[color:var(--t-br06)] px-3.5 py-3">
          <AppLogo size="md" className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--t-text)]">{APP_NAME}</div>
          </div>
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--t-text-muted)] transition hover:bg-[var(--t-muted)] hover:text-[var(--t-text)] lg:hidden"
            aria-label="关闭侧栏"
            onClick={() => setMobileNavOpen(false)}
          >
            <span className="text-xl leading-none" aria-hidden>
              ×
            </span>
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-[color:var(--t-br06)] px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--t-text-caption)]">账户</div>
            <div className="truncate text-[11px] text-[var(--t-text)]" title={getAuthProfile()?.username ?? ""}>
              {getAuthProfile()?.username ?? "—"}
            </div>
            <div className="mt-0.5 text-[10px] font-semibold tabular-nums text-[var(--t-text-muted)]">
              积分 {pointBalance ? formatPoints(pointBalance.balance) : balanceError ? "加载失败" : "加载中"}
            </div>
          </div>
          {onLogout ? (
            <button
              type="button"
              onClick={onLogout}
              className="shrink-0 rounded-md border border-[color:var(--t-br08)] bg-[var(--t-muted)] px-2 py-1 text-[10px] font-medium text-[var(--t-text-muted)] transition hover:border-[color:var(--t-br11)] hover:bg-[var(--t-muted-hover)] hover:text-[var(--t-text)]"
            >
              退出登录
            </button>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 p-2.5">
          <button
            type="button"
            onClick={newChat}
            className="qp-btn-primary"
          >
            <span className="text-base leading-none font-light">+</span>
            新对话
          </button>
          <button
            type="button"
            onClick={() => setHistorySearchOpen(true)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-muted)] px-3 py-2 text-[11px] font-medium text-[var(--t-text-muted)] transition hover:border-[color:var(--t-br11)] hover:bg-[var(--t-muted-hover)] hover:text-[var(--t-text)]"
            title="搜索历史对话（Ctrl+K）"
          >
            <span>搜索历史对话</span>
            <kbd className="rounded border border-[color:var(--t-br08)] bg-[var(--t-field)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--t-text-dim)]">
              Ctrl K
            </kbd>
          </button>
          <button
            type="button"
            onClick={openExportModal}
            className="w-full rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-muted)] px-3 py-2 text-[11px] font-medium text-[var(--t-text-muted)] transition hover:border-[color:var(--t-br11)] hover:bg-[var(--t-muted-hover)] hover:text-[var(--t-text)]"
            title="选择会话并导出为 Markdown、Word、PDF 或 JSON"
          >
            导出聊天记录
          </button>
          <button
            type="button"
            onClick={() => {
              setUrlDraft(getLlmChatCompletionsUrl() ?? "");
              setKeyDraft(getOpenAiKey() ?? "");
              setModelDraft(getOpenAiModel() ?? "");
              setApiKeyModalOpen(true);
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-muted)] px-3 py-2 text-[11px] font-medium text-[var(--t-text-muted)] transition hover:border-[color:var(--t-accent-ring)] hover:bg-[var(--t-llm-row-hover-bg)] hover:text-[var(--t-llm-row-hover-text)]"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${llmClientHint ? "bg-[var(--t-accent)]" : "bg-[var(--t-accent-dot-off)]"}`}
              aria-hidden
            />
            查询重写（LLM）设置
          </button>
        </div>
        <div className="flex flex-col gap-1 border-b border-[color:var(--t-br06)] px-2.5 py-2">
          <label className="text-[10px] font-semibold text-[var(--t-text-label)]" htmlFor="paper-persona">
            身份 / 用途（Skill）
          </label>
          <select
            id="paper-persona"
            value={personaId}
            onChange={(e) => {
              const v = e.target.value;
              setPersonaId(v);
              setPersonaIdState(v);
            }}
            className="w-full rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] px-2 py-1.5 text-[11px] text-[var(--t-text)]"
          >
            {personaList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {sessions.map((s) => (
            <div key={s.id} className="group relative mb-1">
              <button
                type="button"
                onClick={() => selectSession(s.id)}
                className={`qp-session-item ${s.id === activeId ? "qp-session-item--active" : ""}`}
              >
                <span className="line-clamp-2 text-[var(--t-text)]">{s.title}</span>
              </button>
              <button
                type="button"
                title="删除"
                onClick={(e) => deleteSession(s.id, e)}
                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded-md p-1 text-[var(--t-text-dim)] hover:bg-surface-hover hover:text-[var(--t-text)] group-hover:block"
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="border-t border-[color:var(--t-br06)] px-2.5 py-2">
          <div className="mb-1.5 pl-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--t-text-caption)]">
            外观
          </div>
          <div className="flex gap-1" role="group" aria-label="主题">
            <button
              type="button"
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
              className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition ${
                theme === "dark"
                  ? "border-[color:var(--t-br10)] bg-[var(--t-elevated)] text-[var(--t-text)] shadow-sm"
                  : "border-transparent text-[var(--t-text-muted)] hover:bg-[var(--t-muted)] hover:text-[var(--t-text)]"
              }`}
            >
              深色
            </button>
            <button
              type="button"
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
              className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition ${
                theme === "light"
                  ? "border-[color:var(--t-br10)] bg-[var(--t-elevated)] text-[var(--t-text)] shadow-sm"
                  : "border-transparent text-[var(--t-text-muted)] hover:bg-[var(--t-muted)] hover:text-[var(--t-text)]"
              }`}
            >
              浅色
            </button>
          </div>
        </div>
        <div className="border-t border-[color:var(--t-br06)] p-2.5 text-[10px] leading-relaxed text-[var(--t-text-label)]">
          本地 SQLite 缓存 + arXiv / Crossref。DOI 外链可访问；全文权限以机构为准。
          <button
            type="button"
            onClick={() => {
              if (window.confirm("清除已保存的「不满意」输出偏好？之后综述不再自动套用这些约束。")) {
                clearOutputPreferences();
              }
            }}
            className="qp-link-accent mt-2 block w-full text-left text-[10px] underline underline-offset-2"
          >
            清除「不满意」输出偏好
          </button>
        </div>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--t-surface)]">
        <header className="qp-app-header-safe relative z-10 flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--t-br06)] bg-[var(--t-surface)] px-2 sm:px-3">
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-muted)] text-[var(--t-text-muted)] transition hover:border-[color:var(--t-br11)] hover:bg-[var(--t-muted-hover)] hover:text-[var(--t-text)] lg:hidden"
            aria-label="打开菜单"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            <IconMenu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <h1 className="truncate text-[13px] font-semibold tracking-tight text-[var(--t-text)]">{APP_NAME}</h1>
          </div>
          <div className="shrink-0 whitespace-nowrap text-right text-[10px] font-semibold tabular-nums text-[var(--t-text-muted)] lg:hidden">
            {pointBalance ? `${formatPoints(pointBalance.balance)} 积分` : "积分 —"}
          </div>
        </header>

        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 py-5 sm:px-4 sm:py-6">
            {!active?.messages.length && (
              <div className="relative flex min-h-[min(52vh,520px)] flex-col items-center justify-center px-4 pb-8 pt-6 text-center sm:min-h-[48vh]">
                <div className="qp-welcome-orb" aria-hidden />
                <AppLogo size="xl" className="relative mb-5" />
                <h2 className="relative max-w-[min(92vw,560px)] text-[clamp(1.4rem,4.5vw,2rem)] font-semibold leading-snug tracking-tight text-[var(--t-text-heading)]">
                  {emptyWelcome.headline}
                </h2>
                <p className="relative mt-4 max-w-md text-[15px] leading-relaxed text-[var(--t-text-muted)]">
                  {emptyWelcome.subline}
                </p>
              </div>
            )}

            {active?.messages.map((m) => (
              <div
                key={m.id}
                id={`msg-${m.id}`}
                className={`qp-message-enter flex items-start gap-2 sm:gap-3 ${
                  exportPickMode && active?.id === exportPickSessionId
                    ? "rounded-xl py-0.5 pl-1 ring-1 ring-[color:var(--t-accent-ring)] sm:pl-0"
                    : ""
                }`}
              >
                {exportPickMode && active?.id === exportPickSessionId ? (
                  <label className="mt-1 flex shrink-0 cursor-pointer pt-0.5">
                    <input
                      type="checkbox"
                      checked={!!exportPickSelected[m.id]}
                      onChange={() => toggleExportPickMessage(m.id)}
                      className="mt-0.5 h-4 w-4 shrink-0 qp-accent-input"
                      aria-label={m.role === "user" ? "勾选该条用户消息" : "勾选该条助手消息"}
                    />
                  </label>
                ) : null}
                <div className="flex min-w-0 flex-1 gap-3 sm:gap-4">
                  <div className={m.role === "user" ? "qp-avatar-user" : "qp-avatar-assistant"}>
                    {m.role === "user" ? (
                      "我"
                    ) : (
                      <img src="/logo.jpg" alt="AI" className="h-full w-full object-contain mix-blend-multiply" draggable={false} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 pt-1">
                    {m.role === "user" ? (
                      <UserBubble text={m.content} />
                    ) : (
                      <AssistantBlock
                        msg={m}
                        onFeedback={handleFeedback}
                        feedbackLock={feedbackByMessage[m.id]}
                        onPdfFulfill={handlePdfFulfill}
                        billingDisabled={billingDisabled || pdfBusyKey != null}
                        chartBusy={chartBusyMessageId === m.id}
                        onMatplotlibChart={handleMatplotlibChart}
                        dataTableBusy={dataTableBusyMessageId === m.id}
                        onGenerateDataTable={handleGenerateDataTable}
                        pptxBusy={pptxBusyMessageId === m.id}
                        flowBusy={flowBusyMessageId === m.id}
                        onDownloadPptx={handleDownloadPptx}
                        onBuildFlowchart={handleBuildFlowchart}
                      />
                    )}
                  </div>
                </div>
              </div>
            ))}
            {busy && !activeAssistantShowsProgress && (
              <div className="qp-message-enter flex gap-3 sm:gap-4">
                <div className="qp-avatar-assistant">
                  <img src="/logo.jpg" alt="AI" className="h-full w-full object-contain mix-blend-multiply" draggable={false} />
                </div>
                <div className="min-w-0 flex-1">
                  <LoadingIndicator
                    label={getMainSearchLoadingText({
                      channel: searchChannel,
                      patentsOnly: patentsOnlyEnabled,
                      deepMine: deepMineEnabled,
                    })}
                  />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="qp-app-input-footer relative z-10 shrink-0 border-t border-[color:var(--t-br06)] bg-[var(--t-surface)] p-2 sm:p-3">
          <div className="mx-auto max-w-3xl">
            <div
              className="qp-input-shell"
              onDragOver={(e) => {
                if (uploadBusy || exportPickMode) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={onUploadDrop}
            >
              <ComposerToolbar
                channel={searchChannel}
                sort={searchSort}
                queryField={queryField}
                patentsOnly={patentsOnlyEnabled}
                deepMine={deepMineEnabled}
                onChannel={setSearchChannel}
                onSort={setSearchSort}
                onQueryField={setQueryField}
                onPatentsOnly={setPatentsOnlyEnabled}
                onDeepMine={setDeepMineEnabled}
                disabled={busy || exportPickMode}
              />
              <div className="relative">
                {(uploadBusy || uploadError || attachments.length > 0 || uploadNotice) ? (
                  <div
                    className={`px-3 py-2 text-[12px] ${
                      uploadError
                        ? "bg-red-500/10"
                        : uploadBusy
                          ? "bg-[color:var(--t-br04)]"
                          : "bg-[var(--t-muted)]"
                    }`}
                    role="status"
                    aria-live="polite"
                  >
                    {uploadError ? (
                      <div className="flex items-start gap-2 text-red-800 dark:text-red-200">
                        <span className="shrink-0 font-bold" aria-hidden>
                          !
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">上传失败</p>
                          <p className="mt-0.5 text-[11px] leading-relaxed opacity-90">{uploadError}</p>
                          <button
                            type="button"
                            className="mt-1 text-[11px] underline opacity-80 hover:opacity-100"
                            onClick={() => setUploadError(null)}
                          >
                            关闭
                          </button>
                        </div>
                      </div>
                    ) : uploadBusy ? (
                      <div className="flex items-center gap-2 text-[var(--t-text)]">
                        <LoadingSpinner />
                        <span>
                          正在解析
                          {uploadingFileName ? (
                            <span className="font-medium">「{uploadingFileName}」</span>
                          ) : (
                            "文件"
                          )}
                          …
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        <p className="font-medium text-[var(--t-text)]">
                          ✓ 已附加 {attachments.length} 个文件
                          {uploadNotice ? (
                            <span className="ml-1 font-normal text-[var(--t-text-muted)]">· {uploadNotice}</span>
                          ) : null}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {attachments.map((a) => (
                            <span
                              key={a.id}
                              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-chip-bg)] py-1 pl-2 pr-1 text-[11px] text-[var(--t-text-chrome)]"
                              title={`已解析 ${a.chars.toLocaleString()} 字`}
                            >
                              <span className="max-w-[14rem] truncate font-medium">{a.name}</span>
                              <span className="text-[10px] text-[var(--t-text-muted)]">
                                {a.chars.toLocaleString()} 字
                              </span>
                              <button
                                type="button"
                                className="rounded p-0.5 text-[var(--t-text-code)] hover:bg-[color:var(--t-br10)]"
                                onClick={() => removeAttachment(a.id)}
                                aria-label={`移除 ${a.name}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
                <input
                  ref={fileInputRef}
                  type="file"
                  tabIndex={-1}
                  className="pointer-events-none absolute h-0 w-0 opacity-0"
                  multiple
                  accept=".pdf,.pptx,.ppsx,.md,.markdown,.txt,.text,.doc,.docx,.docm,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
                  onChange={onFilesSelected}
                  disabled={uploadBusy || exportPickMode}
                />
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  disabled={busy || uploadBusy || exportPickMode || billingDisabled}
                  placeholder={
                    billingDisabled
                      ? `积分已用完（当前余额 ${formatPoints(pointBalance?.balance)}），请充值后继续使用`
                      : exportPickMode
                        ? "请先完成或取消上方的导出消息选择…"
                        : uploadBusy
                          ? LOADING_UPLOAD
                          : "发消息…（可拖放文件）"
                  }
                  className="max-h-40 min-h-[40px] w-full resize-none bg-transparent px-2.5 py-2 pl-9 pr-11 text-[13px] leading-snug text-[var(--t-text)] placeholder:text-[var(--t-placeholder)] focus:outline-none disabled:opacity-60"
                />
                <button
                  type="button"
                  disabled={uploadBusy || exportPickMode}
                  onClick={() => {
                    if (uploadBusy || exportPickMode) return;
                    fileInputRef.current?.click();
                  }}
                  className={`absolute bottom-1.5 left-1.5 z-20 flex h-8 w-8 items-center justify-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    attachments.length > 0
                      ? "border-[color:var(--t-accent-ring)] bg-[var(--t-accent-muted)] text-[var(--t-text)] ring-1 ring-[color:var(--t-accent-ring)]"
                      : "border-[color:var(--t-br08)] bg-[var(--t-icon-btn)] text-[var(--t-text-chrome)] hover:border-[color:var(--t-br12)] hover:bg-[var(--t-icon-btn-hover)] hover:text-[var(--t-text)]"
                  }`}
                  aria-label={
                    attachments.length > 0 ? `已附加 ${attachments.length} 个文件，点击继续添加` : "上传文件"
                  }
                  title="支持 PDF、PPTX、Markdown、TXT、Word（.doc / .docx），单文件 ≤100MB"
                >
                  {uploadBusy ? (
                    <LoadingSpinner />
                  ) : (
                    <IconPaperclip className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={() => void send(input)}
                  className={`absolute bottom-1.5 right-1.5 z-20 flex h-8 w-8 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-35 ${
                    canSend ? "qp-btn-send-active" : "bg-[var(--t-muted)] text-[var(--t-text-muted)]"
                  }`}
                  aria-label="发送"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M3 11.5v1l18 8.5v-19L3 11.5zm2.2 1L18 5.5v13L5.2 12.5H5v-1h.2z" />
                  </svg>
                </button>
              </div>
            </div>
            <p className="mt-1 text-center text-[9px] leading-snug text-[var(--t-text-footer)]">
              回答文字 0.05 积分/字符 · 图表自动生成 0.1 积分/有效数据点 · PDF 1 积分/文件
              {pricing ? ` · 1 积分=${pricing.unitsPerPoint} units` : ""}
              {willAttachConvoContext ? " · 含本对话上文" : ""}
              {billingDisabled ? ` · 积分已用完（当前余额 ${formatPoints(pointBalance?.balance)}），请充值后继续使用` : ""}
            </p>
          </div>
        </div>
      </main>
    </div>
    </>
  );
}
