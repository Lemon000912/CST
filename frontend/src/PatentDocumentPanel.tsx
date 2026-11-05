import { useMemo } from "react";
import { patentDocumentEntries } from "./patentLinks";
import type { Paper } from "./types";

export function PatentDocumentPanel({ markdown, papers }: { markdown: string; papers?: Paper[] }) {
  const entries = useMemo(() => patentDocumentEntries(markdown, papers), [markdown, papers]);
  const style = "break-all font-medium text-[var(--t-prose-link)] underline underline-offset-2 hover:opacity-80";
  return (
    <section className="not-prose my-4 rounded-xl border border-[color:var(--t-br12)] bg-[var(--t-field)] p-4" aria-label="专利原文与官方入口">
      <h3 className="mb-2 text-sm font-semibold text-[var(--t-text)]">专利原文与官方入口</h3>
      <p className="mb-3 text-xs leading-relaxed text-[var(--t-text-muted)]">
        按下列公开号打开对应文献，核对正文中的专利名称和技术内容。
      </p>
      <div className="mb-3 text-xs leading-relaxed">
        <a href="https://data.epo.org/publication-server/" target="_blank" rel="noopener noreferrer" className={style}>European Publication Server（欧洲专利官方发布平台）</a>
        <p className="mt-1 text-[var(--t-text-muted)]">提供 EP 欧洲专利文献；CN 等其他国家编号请使用其对应专利页。具体格式是否可用以发布平台为准。</p>
      </div>
      {entries.length > 0 ? (
        <ul className="m-0 list-none space-y-3 p-0">
          {entries.map(entry => (
            <li key={entry.number} className="rounded-lg border border-[color:var(--t-br08)] px-3 py-2 text-xs leading-relaxed">
              <strong className="text-[var(--t-text)]">{entry.number}</strong>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
                <a href={entry.source ?? entry.document} target="_blank" rel="noopener noreferrer" className={style}>
                  {entry.source ? "查看专利来源页" : "按公开号打开专利页"}
                </a>
                <a href={entry.search} target="_blank" rel="noopener noreferrer" className={style}>检索该编号</a>
                {entry.pdf && <a href={entry.pdf} target="_blank" rel="noopener noreferrer" className={style}>来源 PDF</a>}
                {entry.european && <>
                  <a href={entry.european.pdf} target="_blank" rel="noopener noreferrer" className={style}>European Publication Server · PDF 入口</a>
                  <a href={entry.european.html} target="_blank" rel="noopener noreferrer" className={style}>EPO 原文网页</a>
                </>}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="mb-3 text-xs text-[var(--t-text-muted)]">回答中未识别到完整公开号，可在官方入口按编号查询。</p>}
    </section>
  );
}
