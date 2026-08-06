import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
} from "docx";
import { saveAs } from "file-saver";
import { LOADING_PDF } from "./loadingCopy";
import type { jsPDF } from "jspdf";
import type { ChatSession, Paper } from "./types";
import { APP_EXPORT_DOC_TITLE, APP_NAME_FULL } from "./branding";

export type ExportFormat = "markdown" | "docx" | "pdf" | "json";

/** 解析 1-based 闭区间 [start1, end1]，非法时返回 null */
export function parseMessageRange1Based(
  messageCount: number,
  startStr: string,
  endStr: string,
): { start1: number; end1: number } | null {
  const n = Math.max(0, Math.floor(messageCount));
  if (n === 0) return { start1: 1, end1: 0 };
  let a = Math.floor(Number(String(startStr).trim()));
  let b = Math.floor(Number(String(endStr).trim()));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  a = Math.max(1, Math.min(n, a));
  b = Math.max(1, Math.min(n, b));
  if (a > b) [a, b] = [b, a];
  return { start1: a, end1: b };
}

/** 仅截取消息列表（浅拷贝会话）；标题在非标全量时加后缀便于辨认 */
export function sliceSessionMessages(s: ChatSession, start1: number, end1: number): ChatSession {
  const n = s.messages.length;
  if (n === 0) return { ...s, messages: [] };
  let a = Math.floor(start1);
  let b = Math.floor(end1);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ...s, messages: [...s.messages] };
  a = Math.max(1, Math.min(n, a));
  b = Math.max(1, Math.min(n, b));
  if (a > b) [a, b] = [b, a];
  const slice = s.messages.slice(a - 1, b);
  const full = a === 1 && b === n;
  return {
    ...s,
    messages: slice,
    title: full ? s.title : `${s.title}（导出第 ${a}–${b} 条）`,
  };
}

/** 按勾选的消息 id 导出（保持会话内时间序）；ids 含全部消息时视为整会话 */
export function filterSessionMessagesByIdSet(s: ChatSession, ids: ReadonlySet<string>): ChatSession {
  const slice = s.messages.filter((m) => ids.has(m.id));
  const full = slice.length === s.messages.length;
  return {
    ...s,
    messages: slice,
    title: full ? s.title : `${s.title}（已选 ${slice.length} 条）`,
  };
}

function exportStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mdLine(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * 导出 Markdown：以标题层级为主（`#` 总标题 → `##` 会话 → `###` 角色/会话信息 → `####` 小节）。
 */
export function sessionsToMarkdown(sessions: ChatSession[]): string {
  const parts: string[] = [];
  parts.push(`# ${APP_NAME_FULL} · 聊天记录导出`);
  parts.push("");
  parts.push(`## 导出信息`);
  parts.push("");
  parts.push(`- **导出时间**：${new Date().toLocaleString("zh-CN")}`);
  parts.push(`- **会话数量**：${sessions.length}`);
  parts.push(`- **说明**：若会话标题含「导出第」「已选」等，表示为部分消息导出。`);
  parts.push("");
  parts.push("---");
  parts.push("");

  for (const s of sessions) {
    parts.push(`## ${s.title}`);
    parts.push("");
    parts.push(`### 会话信息`);
    parts.push("");
    parts.push(`- **会话 ID**：\`${s.id}\``);
    parts.push(`- **更新时间**：${new Date(s.updatedAt).toLocaleString("zh-CN")}`);
    parts.push("");
    if (!s.messages.length) {
      parts.push("*（本会话无消息）*");
      parts.push("");
      parts.push("---");
      parts.push("");
      continue;
    }
    for (const m of s.messages) {
      parts.push(m.role === "user" ? "### 用户" : "### 助手");
      parts.push("");
      if (m.content?.trim()) {
        parts.push(m.content.trim());
        parts.push("");
      }
      if (m.error) {
        parts.push("*本条为错误回复。*");
        parts.push("");
      }
      if (m.role === "assistant" && m.meta?.personaLabel) {
        parts.push(`> 检索时身份（Skill）：${mdLine(m.meta.personaLabel)}`);
        parts.push("");
      }
      if (m.meta?.synthesis?.trim() || (m.meta?.synthesisPlan && typeof m.meta.synthesisPlan === "object")) {
        parts.push("#### 结论与方案（据摘录）");
        parts.push("");
        if (m.meta.synthesis?.trim()) {
          parts.push(m.meta.synthesis.trim());
          parts.push("");
        }
        if (m.meta.synthesisPlan && typeof m.meta.synthesisPlan === "object") {
          parts.push("##### 结构化方案（synthesisPlan，与接口 JSON 字段一致）");
          parts.push("");
          parts.push("```json");
          parts.push(JSON.stringify(m.meta.synthesisPlan, null, 2));
          parts.push("```");
          parts.push("");
        }
        if (m.meta.synthesisPlanNote) {
          parts.push(`*synthesisPlanNote*：\`${mdLine(String(m.meta.synthesisPlanNote))}\``);
          parts.push("");
        }
      }
      {
        const ch = m.meta;
        const hasCh =
          ch &&
          (ch.rewriteNote ||
            (ch.sourcesUsed && ch.sourcesUsed.length) ||
            ch.channel != null ||
            ch.sort != null ||
            ch.latencyMs != null);
        if (hasCh && ch) {
          parts.push("#### 检索与渠道");
          parts.push("");
          if (ch.rewriteNote) {
            parts.push(`- **改写标记**：${mdLine(String(ch.rewriteNote))}`);
          }
          if (ch.sourcesUsed?.length) {
            parts.push(`- **数据源**：${ch.sourcesUsed.map(mdLine).join("、")}`);
          }
          if (ch.channel != null) {
            parts.push(`- **渠道**：${mdLine(String(ch.channel))}`);
          }
          if (ch.sort != null) {
            parts.push(`- **排序**：${mdLine(String(ch.sort))}`);
          }
          if (ch.latencyMs != null) {
            parts.push(`- **耗时**：${ch.latencyMs} ms`);
          }
          parts.push("");
        }
      }
      if (m.papers?.length) {
        parts.push("#### 文献列表");
        parts.push("");
        let k = 0;
        for (const p of m.papers) {
          k += 1;
          parts.push(`${k}. **${mdLine(p.title)}**`);
          parts.push(`   - 作者：${p.authors.map(mdLine).join("、")}`);
          if (p.published) parts.push(`   - 日期：${p.published.slice(0, 10)}`);
          if (p.source) parts.push(`   - 来源：${mdLine(String(p.source))}`);
          parts.push(`   - [摘要页](${p.absUrl}) · [PDF](${p.pdfUrl})`);
          const sum = (p.summary || "").trim();
          if (sum) {
            const excerpt = sum.replace(/\s+/g, " ").slice(0, 420);
            parts.push(`   - 摘要摘录：${excerpt}${sum.length > 420 ? "…" : ""}`);
          }
          parts.push("");
        }
      }
    }
    parts.push("---");
    parts.push("");
  }
  return parts.join("\n");
}

function sessionsToHtml(sessions: ChatSession[]): string {
  const blocks: string[] = [];
  blocks.push(
    `<div style="font-family:system-ui,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:11px;line-height:1.55;color:#111;">`,
  );
  blocks.push(`<h1 style="font-size:18px;margin:0 0 12px;">${APP_EXPORT_DOC_TITLE}</h1>`);
  blocks.push(
    `<p style="color:#555;margin:0 0 16px;">导出 ${escapeHtml(new Date().toLocaleString("zh-CN"))} · 共 ${sessions.length} 个会话</p>`,
  );

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (i > 0) blocks.push(`<div style="page-break-before:always;"></div>`);
    blocks.push(`<h2 style="font-size:15px;margin:16px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">${escapeHtml(s.title)}</h2>`);
    blocks.push(
      `<p style="color:#666;font-size:10px;margin:0 0 12px;">ID ${escapeHtml(s.id)} · ${escapeHtml(new Date(s.updatedAt).toLocaleString("zh-CN"))}</p>`,
    );
    if (!s.messages.length) {
      blocks.push(`<p style="color:#888;">（无消息）</p>`);
      continue;
    }
    for (const m of s.messages) {
      blocks.push(
        `<h3 style="font-size:12px;margin:14px 0 6px;color:#1d4ed8;">${m.role === "user" ? "用户" : "助手"}</h3>`,
      );
      if (m.content?.trim()) {
        blocks.push(
          `<pre style="white-space:pre-wrap;margin:0 0 8px;padding:8px;background:#f6f6f6;border-radius:6px;font-size:10px;">${escapeHtml(m.content.trim())}</pre>`,
        );
      }
      const meta = m.meta;
      if (meta?.synthesis?.trim()) {
        blocks.push(`<p style="font-size:11px;font-weight:600;margin:10px 0 4px;">结论与方案</p>`);
        blocks.push(
          `<pre style="white-space:pre-wrap;margin:0 0 8px;padding:8px;background:#f0faf6;border-radius:6px;font-size:10px;">${escapeHtml(meta.synthesis.trim())}</pre>`,
        );
      }
      if (meta?.synthesisPlan && typeof meta.synthesisPlan === "object") {
        blocks.push(`<p style="font-size:11px;font-weight:600;margin:8px 0 4px;">synthesisPlan（JSON）</p>`);
        blocks.push(
          `<pre style="white-space:pre-wrap;margin:0 0 8px;padding:8px;background:#f6f6f6;border-radius:6px;font-size:9px;">${escapeHtml(JSON.stringify(meta.synthesisPlan, null, 2))}</pre>`,
        );
      }
      if (m.papers?.length) {
        blocks.push(`<p style="font-size:11px;font-weight:600;margin:8px 0 4px;">文献</p><ul style="margin:0;padding-left:18px;">`);
        for (const p of m.papers) {
          blocks.push(`<li style="margin-bottom:6px;">`);
          blocks.push(`<div style="font-weight:600;">${escapeHtml(p.title)}</div>`);
          blocks.push(
            `<div style="font-size:10px;color:#444;">${escapeHtml(p.authors.join(", "))}</div>`,
          );
          blocks.push(
            `<div style="font-size:10px;"><a href="${escapeHtml(p.absUrl)}">摘要</a> · <a href="${escapeHtml(p.pdfUrl)}">PDF</a></div>`,
          );
          blocks.push(`</li>`);
        }
        blocks.push(`</ul>`);
      }
    }
  }
  blocks.push(`</div>`);
  return blocks.join("");
}

function paperParagraphs(p: Paper): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: p.title, bold: true })],
    }),
    new Paragraph({
      children: [new TextRun({ text: `作者：${p.authors.join("、")}`, size: 20 })],
    }),
  ];
  if (p.published) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: `日期：${p.published.slice(0, 10)}`, size: 20 })],
      }),
    );
  }
  out.push(
    new Paragraph({
      children: [
        new ExternalHyperlink({
          children: [new TextRun({ text: "摘要页", style: "Hyperlink" })],
          link: p.absUrl,
        }),
        new TextRun({ text: "  ·  ", size: 20 }),
        new ExternalHyperlink({
          children: [new TextRun({ text: "PDF", style: "Hyperlink" })],
          link: p.pdfUrl,
        }),
      ],
    }),
  );
  return out;
}

function sessionToDocxChildren(s: ChatSession): Paragraph[] {
  const blocks: Paragraph[] = [];
  blocks.push(
    new Paragraph({
      text: s.title,
      heading: HeadingLevel.HEADING_1,
    }),
  );
  blocks.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `会话 ${s.id} · ${new Date(s.updatedAt).toLocaleString("zh-CN")}`,
          italics: true,
          size: 18,
        }),
      ],
    }),
  );
  if (!s.messages.length) {
    blocks.push(new Paragraph({ children: [new TextRun("（无消息）")] }));
    return blocks;
  }
  for (const m of s.messages) {
    blocks.push(
      new Paragraph({
        text: m.role === "user" ? "用户" : "助手",
        heading: HeadingLevel.HEADING_2,
      }),
    );
    const body = (m.content || " ").trim() || " ";
    for (const line of body.split(/\n/)) {
      blocks.push(new Paragraph({ children: [new TextRun(line || " ")] }));
    }
    if (m.meta?.synthesis?.trim() || (m.meta?.synthesisPlan && typeof m.meta.synthesisPlan === "object")) {
      blocks.push(
        new Paragraph({
          text: "结论与方案",
          heading: HeadingLevel.HEADING_3,
        }),
      );
      if (m.meta.synthesis?.trim()) {
        for (const line of m.meta.synthesis.trim().split(/\n/)) {
          blocks.push(new Paragraph({ children: [new TextRun(line || " ")] }));
        }
      }
      if (m.meta.synthesisPlan && typeof m.meta.synthesisPlan === "object") {
        blocks.push(
          new Paragraph({
            children: [new TextRun({ text: "synthesisPlan（JSON）：", bold: true })],
          }),
        );
        const jsonStr = JSON.stringify(m.meta.synthesisPlan, null, 2).slice(0, 12000);
        for (const line of jsonStr.split(/\n/)) {
          blocks.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: "Consolas", size: 16 })],
            }),
          );
        }
      }
    }
    if (m.papers?.length) {
      blocks.push(
        new Paragraph({
          text: "文献",
          heading: HeadingLevel.HEADING_3,
        }),
      );
      for (const p of m.papers) {
        blocks.push(...paperParagraphs(p));
        blocks.push(new Paragraph({ text: "" }));
      }
    }
  }
  return blocks;
}

/** 将整幅 canvas 按 A4 内容区宽度等比缩放后纵向切片写入多页 PDF */
function appendCanvasToPdfPaged(pdf: jsPDF, canvas: HTMLCanvasElement, marginMm: number): void {
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - 2 * marginMm;
  const contentH = pageH - 2 * marginMm;
  if (canvas.width < 2 || contentW <= 0 || contentH <= 0) return;

  const fullH_mm = (canvas.height * contentW) / canvas.width;
  const pxPerPage = (contentH / fullH_mm) * canvas.height;

  let yPx = 0;
  let pageNum = 0;
  while (yPx < canvas.height - 0.5) {
    if (pageNum > 0) pdf.addPage();
    const sliceH = Math.min(canvas.height - yPx, Math.max(1, Math.ceil(pxPerPage)));
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = sliceH;
    const ctx = slice.getContext("2d");
    if (!ctx) break;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, yPx, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
    const dataUrl = slice.toDataURL("image/jpeg", 0.88);
    const sliceH_mm = (sliceH * contentW) / canvas.width;
    pdf.addImage(dataUrl, "JPEG", marginMm, marginMm, contentW, sliceH_mm);
    yPx += sliceH;
    pageNum++;
    if (pageNum > 500) break;
  }
}

export async function exportSessionsToFile(sessions: ChatSession[], format: ExportFormat): Promise<void> {
  if (!sessions.length) return;
  const stamp = exportStamp();
  const base = `paper-query-${stamp}`;

  if (format === "markdown") {
    const md = sessionsToMarkdown(sessions);
    downloadBlob(`${base}.md`, new Blob([md], { type: "text/markdown;charset=utf-8" }));
    return;
  }
  if (format === "json") {
    const json = JSON.stringify(sessions, null, 2);
    downloadBlob(`${base}.json`, new Blob([json], { type: "application/json;charset=utf-8" }));
    return;
  }
  if (format === "docx") {
    const flat: Paragraph[] = [];
    flat.push(
      new Paragraph({
        text: APP_EXPORT_DOC_TITLE,
        heading: HeadingLevel.TITLE,
      }),
    );
    flat.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `导出时间：${new Date().toLocaleString("zh-CN")}`,
            italics: true,
          }),
        ],
      }),
    );
    for (let i = 0; i < sessions.length; i++) {
      if (i > 0) flat.push(new Paragraph({ children: [new PageBreak()] }));
      flat.push(...sessionToDocxChildren(sessions[i]));
    }
    const doc = new Document({
      sections: [{ children: flat }],
    });
    const blob = await Packer.toBlob(doc);
    saveAs(blob, `${base}.docx`);
    return;
  }
  if (format === "pdf") {
    const html = sessionsToHtml(sessions);
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);

    const mask = document.createElement("div");
    mask.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.35)",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "color:#fff",
      "font-size:16px",
      "font-family:system-ui,sans-serif",
    ].join(";");
    mask.textContent = LOADING_PDF;
    document.body.appendChild(mask);

    const iframe = document.createElement("iframe");
    iframe.title = "pdf-export";
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:820px",
      "height:400px",
      "opacity:0.02",
      "border:0",
      "pointer-events:none",
      "z-index:2147483646",
    ].join(";");
    document.body.appendChild(iframe);

    try {
      const idoc = iframe.contentDocument;
      const iwin = iframe.contentWindow;
      if (!idoc || !iwin) throw new Error("无法创建 PDF 内嵌文档");

      idoc.open();
      idoc.write(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;color:#111;font-family:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
</style></head><body>${html}</body></html>`,
      );
      idoc.close();

      const bodyH = Math.min(20000, Math.max(400, idoc.body.scrollHeight + 40));
      iframe.style.height = `${bodyH}px`;

      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      await new Promise((r) => setTimeout(r, 120));

      const target = idoc.body;
      const scale = Math.min(2, Math.max(1, iwin.devicePixelRatio || 1));
      const canvas = await html2canvas(target, {
        scale,
        backgroundColor: "#ffffff",
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: target.scrollWidth,
        windowHeight: target.scrollHeight,
        scrollX: 0,
        scrollY: 0,
      });

      if (canvas.width < 2 || canvas.height < 2) {
        throw new Error("PDF 渲染失败（画布尺寸异常），请改用 Word 或 Markdown 导出");
      }

      const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4", compress: true });
      appendCanvasToPdfPaged(pdf, canvas, 10);
      pdf.save(`${base}.pdf`);
    } finally {
      mask.remove();
      iframe.remove();
    }
    return;
  }
}
