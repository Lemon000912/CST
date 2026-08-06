import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatMessage } from "./types";

export type ProcessStep = {
  step_no?: number | string;
  action: string;
  inputs?: string;
  outputs?: string;
  note?: string;
};

export type FlowchartArtifact = {
  mermaid: string;
  steps?: ProcessStep[];
  recipeLines?: string[];
  svgBase64?: string | null;
  title?: string;
};

type Props = {
  artifact: FlowchartArtifact;
  className?: string;
};

export function ProcessArtifactToolbar({
  msg,
  pptxBusy,
  flowBusy,
  onDownloadPptx,
  onBuildFlowchart,
}: {
  msg: ChatMessage;
  pptxBusy?: boolean;
  flowBusy?: boolean;
  onDownloadPptx: (msg: ChatMessage) => void | Promise<void>;
  onBuildFlowchart: (msg: ChatMessage) => void | Promise<void>;
}) {
  const hasSynth = Boolean(msg.meta?.synthesis?.trim());
  if (!hasSynth && !msg.meta?.synthesisPlan) return null;

  const hasFlow = Boolean(msg.meta?.artifacts?.flowchart?.mermaid);

  return (
    <div className="mt-3 rounded-xl border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-3">
      <p className="mb-2 text-[11px] font-semibold text-[var(--t-text)]">工艺流程图与汇报 PPT</p>
      <p className="mb-2 text-[10px] leading-relaxed text-[var(--t-text-dim)]">
        综述含<strong>配方、工序、制备流程</strong>时，检索完成后会自动生成流程图；也可手动重新生成。PPT 含方案要点、配方摘录、工序列表、关键数据表，并嵌入流程图。
      </p>
      {msg.meta?.artifactError ? (
        <p className="mb-2 rounded-lg border border-[color:var(--t-error)]/35 bg-[color:var(--t-error)]/08 px-2 py-1.5 text-[10px] text-[var(--t-error)]">
          {msg.meta.artifactError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!flowBusy}
          onClick={() => void onBuildFlowchart(msg)}
          className="rounded-lg border border-[color:var(--t-br10)] bg-[var(--t-surface)] px-3 py-1.5 text-[11px] font-semibold text-[var(--t-text)] hover:bg-[var(--t-elevated)] disabled:opacity-50"
        >
          {flowBusy ? "生成中…" : hasFlow ? "重新生成流程图" : "生成工艺流程图"}
        </button>
        <button
          type="button"
          disabled={!!pptxBusy}
          onClick={() => void onDownloadPptx(msg)}
          className="rounded-lg bg-gradient-to-b from-[#7c3aed] to-[#6d28d9] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:from-[#8b5cf6] hover:to-[#7c3aed] disabled:opacity-50"
        >
          {pptxBusy ? "打包中…" : "下载 PPT"}
        </button>
      </div>
      {hasFlow && msg.meta?.artifacts?.flowchart ? (
        <ProcessFlowchartPanel artifact={msg.meta.artifacts.flowchart} className="mt-2" />
      ) : null}
    </div>
  );
}

function FlowchartLightbox({
  open,
  title,
  svgHtml,
  onClose,
}: {
  open: boolean;
  title: string;
  svgHtml: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !svgHtml) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-start justify-center overflow-y-auto bg-[var(--t-overlay)] px-3 pb-8 pt-[min(10vh,4rem)] sm:px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flowchart-lightbox-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[min(88vh,900px)] w-full max-w-[min(96vw,1200px)] flex-col overflow-hidden rounded-xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] shadow-lg shadow-[var(--t-modal-shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--t-br06)] px-4 py-3">
          <h2 id="flowchart-lightbox-title" className="text-[14px] font-semibold text-[var(--t-text)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[color:var(--t-br10)] px-2.5 py-1 text-[12px] text-[var(--t-text-dim)] hover:bg-[var(--t-elevated)]"
            aria-label="关闭"
          >
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
          <div
            className="flowchart-lightbox-svg flex justify-center [&_svg]:h-auto [&_svg]:max-w-none [&_svg]:min-w-[min(100%,520px)]"
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        </div>
        <p className="shrink-0 border-t border-[color:var(--t-br06)] px-4 py-2 text-center text-[10px] text-[var(--t-text-dim)]">
          点击空白处或按 Esc 关闭 · 可滚动查看完整流程
        </p>
      </div>
    </div>,
    document.body,
  );
}

/** 渲染 Mermaid 工艺流程图（由后端生成 mermaid 源码） */
export function ProcessFlowchartPanel({ artifact, className = "" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [svgHtml, setSvgHtml] = useState("");
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const flowTitle =
    artifact.title?.trim() ||
    `工艺流程图${artifact.steps?.length ? `（${artifact.steps.length} 步）` : ""}`;

  const openLightbox = useCallback(() => {
    if (svgHtml) setLightboxOpen(true);
  }, [svgHtml]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setBusy(true);
      setErr(null);
      setSvgHtml("");
      const el = containerRef.current;
      if (!el || !artifact.mermaid?.trim()) {
        setBusy(false);
        return;
      }
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          securityLevel: "strict",
          flowchart: { curve: "basis", htmlLabels: true },
        });
        const { svg } = await mermaid.render(`pq-flow-${uid}`, artifact.mermaid.trim());
        if (cancelled) return;
        el.innerHTML = svg;
        setSvgHtml(svg);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "流程图渲染失败");
          if (artifact.svgBase64) {
            const fallback = `<img alt="工艺流程" src="data:image/svg+xml;base64,${artifact.svgBase64}" class="max-w-full h-auto" />`;
            el.innerHTML = fallback;
            setSvgHtml(fallback);
            setErr(null);
          }
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [artifact.mermaid, artifact.svgBase64, uid]);

  return (
    <>
      <details
        open
        className={`mt-3 rounded-lg border border-[color:var(--t-br08)] bg-[var(--t-field)] px-3 py-2 ${className}`}
      >
        <summary className="cursor-pointer list-none text-[11px] font-semibold text-[var(--t-text)] [&::-webkit-details-marker]:hidden">
          工艺流程图
          {artifact.steps?.length ? `（${artifact.steps.length} 步）` : ""}
          · 点击收起
        </summary>
        <div className="mt-2 overflow-x-auto">
          {busy ? (
            <p className="text-[11px] text-[var(--t-text-dim)]">正在绘制流程图…</p>
          ) : null}
          {err ? <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-300">{err}</p> : null}
          <div
            ref={containerRef}
            role={svgHtml ? "button" : undefined}
            tabIndex={svgHtml ? 0 : undefined}
            aria-label={svgHtml ? "点击查看大图" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              openLightbox();
            }}
            onKeyDown={(e) => {
              if (!svgHtml) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openLightbox();
              }
            }}
            className={`mermaid-wrap group relative flex justify-center rounded-lg [&_svg]:max-w-full ${
              svgHtml
                ? "cursor-zoom-in border border-transparent transition hover:border-[color:var(--t-br10)] hover:bg-[var(--t-elevated)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--t-accent)]/40"
                : ""
            }`}
          >
            {svgHtml ? (
              <span className="pointer-events-none absolute right-2 top-2 rounded-md border border-[color:var(--t-br08)] bg-[var(--t-modal)]/90 px-2 py-0.5 text-[10px] text-[var(--t-text-dim)] opacity-0 transition group-hover:opacity-100">
                点击查看大图
              </span>
            ) : null}
          </div>
          {artifact.recipeLines?.length ? (
            <div className="mt-3 border-t border-[color:var(--t-br06)] pt-2">
              <p className="mb-1 text-[10px] font-medium text-[var(--t-text-label)]">配方 / 组分摘录</p>
              <ul className="list-inside list-disc text-[11px] text-[var(--t-text-card-body)]">
                {artifact.recipeLines.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
      <FlowchartLightbox
        open={lightboxOpen}
        title={flowTitle}
        svgHtml={svgHtml}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  );
}
