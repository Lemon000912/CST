import { useEffect, useMemo, useRef, useState } from "react";
import type { ArxivSearchField, ChatSession, PaperSortKey, SearchChannel } from "./types";
import { createUuid } from "./uuid";

type Trial = {
  remaining: number;
  answers: { requestId?: string; sessionId?: string; started?: number; question: string; answer: string; sources: { title: string; doi: string }[] }[];
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

function guestSessions(trial: Trial | null): ChatSession[] {
  const grouped = new Map<string, ChatSession>();
  for (const [index, row] of (trial?.answers ?? []).entries()) {
    const requestId = row.requestId ?? `guest-${index}`;
    const id = row.sessionId ?? requestId;
    const session = grouped.get(id) ?? { id, title: row.question.slice(0, 28), messages: [], updatedAt: 0 };
    session.updatedAt = row.started ?? index;
    const references = row.sources.map((source, i) =>
      `${i + 1}. ${source.title}${source.doi ? " · https://doi.org/" + encodeURI(source.doi) : ""}`);
    session.messages.push({ id: requestId + "-q", role: "user", content: row.question },
      { id: requestId + "-a", role: "assistant", content: [row.answer, references.join("\n")].filter(Boolean).join("\n\n") });
    grouped.set(id, session);
  }
  return [...grouped.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useSchoolGuest(onLogin?: (register: boolean) => void) {
  const [trial, setTrial] = useState<Trial | null>(null);
  const [error, setError] = useState("");
  // The server history contains completed answers only. Keep the submitted turn
  // in its conversation while waiting, and reconcile it by request ID on success.
  const [submitted, setSubmitted] = useState<{
    id: string; sessionId: string; question: string; started: number; error?: string;
  } | null>(null);
  const busy = submitted !== null && submitted.error === undefined;
  const [retry, setRetry] = useState(0);
  const [siteKey, setSiteKey] = useState("");
  const [challenge, setChallenge] = useState("");
  const [challengeVersion, refreshChallenge] = useState(0);
  const request = useRef({ payload: "", id: "" });
  useEffect(() => {
    if (!onLogin) return;
    const controller = new AbortController();
    fetch("/api/v1/guest/status", { signal: controller.signal, cache: "no-store" })
      .then(async res => {
        if (!res.ok) throw Error();
        const state: Trial = await res.json();
        if (!controller.signal.aborted) { setTrial(state); setError(""); }
      })
      .catch(() => { if (!controller.signal.aborted) setError("暂时无法读取试用次数。"); });
    return () => controller.abort();
  }, [retry, onLogin]);

  async function submit(q: string, sessionId: string, options: {
    channel: SearchChannel; sort: PaperSortKey; field: ArxivSearchField; patents: boolean; persona: string;
  }, onStart: () => void): Promise<"failed" | void> {
    if (trial?.remaining === 0) return onLogin?.(true);
    if (!q || busy || !trial || (siteKey && !challenge)) return;
    const payload = { question: q, sessionId, options };
    const key = JSON.stringify(payload);
    if (request.current.payload !== key) request.current = { payload: key, id: createUuid() };
    setSubmitted({ id: request.current.id, sessionId, question: q, started: Date.now() });
    onStart();
    setError("");
    try {
      const res = await fetch("/api/v1/guest/ask", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": request.current.id },
        body: JSON.stringify({ ...payload, challenge }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "guest-login-required") return onLogin?.(true);
        if (data.code === "guest-challenge") {
          setSiteKey(data.siteKey);
          setChallenge("");
          refreshChallenge(n => n + 1);
        }
        throw Error(data.error || "提问失败，请稍后重试。");
      }
      setTrial(data);
      setSiteKey("");
      request.current = { payload: "", id: "" };
      setSubmitted(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "网络连接失败，请重试。";
      setSubmitted(turn => turn && { ...turn, error: message });
      return "failed";
    }
  }

  const sessions = useMemo(() => {
    const history = guestSessions(trial);
    if (!submitted) return history;
    const { sessionId, id, question, started, error } = submitted;
    const session = history.find(s => s.id === sessionId) ??
      { id: sessionId, title: question.slice(0, 28), updatedAt: started, messages: [] };
    session.messages.push({ id: id + "-q", role: "user", content: question });
    if (error) session.messages.push({ id: id + "-a", role: "assistant", content: error, error: true });
    session.updatedAt = started;
    return [session, ...history.filter(s => s.id !== sessionId)];
  }, [trial, submitted]);
  const notice = <>
    {siteKey && <Challenge key={challengeVersion} siteKey={siteKey} onToken={setChallenge} />}
    {error && <div role="alert">{error} {!trial && <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>重试</button>}</div>}
  </>;
  return { remaining: trial?.remaining, sessions, busy, pendingSessionId: busy ? submitted.sessionId : null, submit, notice,
    ready: Boolean(trial) && (!siteKey || Boolean(challenge)) };
}
