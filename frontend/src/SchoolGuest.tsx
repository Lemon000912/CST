import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSession } from "./types";
import type { AppEdition } from "./edition";

const PENDING_GUEST_SCOPE_KEY = "paper-query-pending-guest-scope-v1:school";
const GUEST_DRAFT_KEY = (edition: AppEdition) => `paper-query-input-draft-v1:${edition}`;

export function rememberPendingGuestScope(scope?: string | null): void {
  if (!scope || !scope.startsWith("trial-")) return;
  try { sessionStorage.setItem(PENDING_GUEST_SCOPE_KEY, scope); } catch { /* ignore */ }
}

export function consumePendingGuestScope(): string | null {
  try {
    const scope = sessionStorage.getItem(PENDING_GUEST_SCOPE_KEY);
    if (scope) sessionStorage.removeItem(PENDING_GUEST_SCOPE_KEY);
    return scope && scope.startsWith("trial-") ? scope : null;
  } catch {
    return null;
  }
}

export function savePendingInputDraft(edition: AppEdition, text: string): void {
  const value = text.trim();
  if (!value) return;
  try { sessionStorage.setItem(GUEST_DRAFT_KEY(edition), text); } catch { /* ignore */ }
}

export function consumePendingInputDraft(edition: AppEdition): string {
  try {
    const value = sessionStorage.getItem(GUEST_DRAFT_KEY(edition)) ?? "";
    if (value) sessionStorage.removeItem(GUEST_DRAFT_KEY(edition));
    return value;
  } catch {
    return "";
  }
}


type Trial = {
  remaining: number;
  scope: string;
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
  const [retry, setRetry] = useState(0);
  const [siteKey, setSiteKey] = useState("");
  const [challenge, setChallenge] = useState("");
  const [challengeVersion, refreshChallenge] = useState(0);
  const refresh = useCallback(() => setRetry(n => n + 1), []);
  useEffect(() => {
    if (!onLogin) return;
    const controller = new AbortController();
    fetch("/api/v1/guest/status", { signal: controller.signal, cache: "no-store" })
      .then(async res => {
        if (!res.ok) throw Error();
        const state: Trial = await res.json();
        if (!controller.signal.aborted) {
          rememberPendingGuestScope(state.scope);
          setTrial(state);
          setError("");
        }
      })
      .catch(() => { if (!controller.signal.aborted) setError("暂时无法读取试用次数。"); });
    return () => controller.abort();
  }, [retry, onLogin]);

  function handleError(code?: string, key?: string) {
    if (code === "guest-login-required") onLogin?.(true);
    if (code === "guest-challenge" && key) {
      setSiteKey(key);
      setChallenge("");
      refreshChallenge(n => n + 1);
    }
  }
  function complete() { setChallenge(""); setSiteKey(""); }
  const legacySessions = useMemo(() => guestSessions(trial), [trial]);
  const notice = <>
    {siteKey && <Challenge key={challengeVersion} siteKey={siteKey} onToken={setChallenge} />}
    {error && <div role="alert">{error} {!trial && <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>重试</button>}</div>}
  </>;
  return { remaining: trial?.remaining, scope: trial?.scope, legacySessions, challenge, notice, refresh, handleError, complete,
    ready: Boolean(trial) && (!siteKey || Boolean(challenge)) };
}
