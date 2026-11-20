import { useEffect, useRef, useState } from "react";
import { AppLogo } from "./AppLogo";
import { APP_NAME } from "./branding";
import { createUuid } from "./uuid";

type Trial = {
  remaining: number;
  answers: { question: string; answer: string; sources: { title: string; doi: string }[] }[];
};
type Turnstile = {
  render: (node: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

function Challenge({ siteKey, onToken }: { siteKey: string; onToken: (value: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let widget: string | undefined;
    const api = () => (window as Window & { turnstile?: Turnstile }).turnstile;
    const render = () => {
      if (container.current && api()) widget = api()!.render(container.current, {
        sitekey: siteKey, callback: onToken, "expired-callback": () => onToken(""),
        "error-callback": () => { setFailed(true); onToken(""); },
      });
    };
    if (api()) { render(); return () => { if (widget) api()?.remove(widget); }; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.onload = render;
    script.onerror = () => setFailed(true);
    document.head.appendChild(script);
    return () => { script.onload = null; script.onerror = null; if (widget) api()?.remove(widget); script.remove(); };
  }, [siteKey, onToken]);
  return <><div ref={container} />{failed && <p>人机验证暂不可用，可登录后继续。</p>}</>;
}

export default function SchoolGuest({ onLogin }: { onLogin: (register: boolean) => void }) {
  const [trial, setTrial] = useState<Trial | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [siteKey, setSiteKey] = useState("");
  const [challenge, setChallenge] = useState("");
  const [challengeVersion, refreshChallenge] = useState(0);
  const request = useRef({ question: "", id: "" });
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/guest/status", { signal: controller.signal, cache: "no-store" })
      .then(async res => {
        if (!res.ok) throw Error();
        const state: Trial = await res.json();
        if (!controller.signal.aborted) { setTrial(state); setError(""); }
      })
      .catch(() => { if (!controller.signal.aborted) setError("暂时无法读取试用次数。"); });
    return () => controller.abort();
  }, [retry]);

  async function submit() {
    if (trial?.remaining === 0 || blocked) return onLogin(true);
    const q = question.trim();
    if (!q || busy || !trial) return;
    if (request.current.question !== q) request.current = { question: q, id: createUuid() };
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/guest/ask", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": request.current.id },
        body: JSON.stringify({ question: q, challenge }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "guest-login-required") setBlocked(true);
        if (data.code === "guest-challenge") {
          setSiteKey(data.siteKey);
          setChallenge("");
          refreshChallenge(n => n + 1);
        }
        throw Error(data.error || "提问失败，请稍后重试。");
      }
      setTrial(data);
      setSiteKey("");
      setQuestion("");
      request.current = { question: "", id: "" };
    } catch (e) { setError(e instanceof Error ? e.message : "网络连接失败，请重试。"); }
    finally { setBusy(false); }
  }

  const exhausted = blocked || trial?.remaining === 0;
  return <main className="h-[100dvh] overflow-y-auto bg-[var(--t-bg)] px-5 py-10 text-[var(--t-text)]">
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="flex items-center gap-3"><AppLogo size="lg" src="/logo.png" />
        <h1 className="flex-1 text-lg font-semibold">{APP_NAME} · 校园版</h1>
        <button onClick={() => onLogin(false)} className="underline">登录</button>
      </header>
      {trial?.answers.map((item, index) => <article key={index} className="space-y-3 rounded-xl border p-5">
        <h2 className="font-semibold">{item.question}</h2><p className="whitespace-pre-wrap">{item.answer}</p>
        {item.sources.length > 0 && <ol className="list-decimal pl-5 text-sm">{item.sources.map((s, i) =>
          <li key={i}>{s.doi ? <a className="underline" target="_blank" rel="noreferrer" href={"https://doi.org/" + s.doi}>{s.title}</a> : s.title}</li>)}</ol>}
      </article>)}
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <label htmlFor="guest-question" className="block font-semibold">你想研究什么问题？</label>
        <textarea id="guest-question" className="w-full rounded-xl border bg-transparent p-3" rows={3} maxLength={800}
          value={question} disabled={busy} onChange={e => setQuestion(e.target.value)} />
        <p aria-live="polite" className="text-sm">{busy ? "正在检索并整理回答…" : trial ? `游客剩余 ${trial.remaining} 次提问` : "正在读取试用次数…"}</p>
        {siteKey && !exhausted && <Challenge key={challengeVersion} siteKey={siteKey} onToken={setChallenge} />}
        {error && <p role="alert">{error} {!trial && <button type="button" onClick={() => setRetry(n => n + 1)}>重试</button>}</p>}
        <button className="rounded-lg bg-blue-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={!trial || busy || (!exhausted && (!question.trim() || Boolean(siteKey && !challenge)))}>
          {exhausted ? "注册或登录后继续" : "提问"}
        </button>
      </form>
    </div>
  </main>;
}
