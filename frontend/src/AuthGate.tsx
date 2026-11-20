import { useCallback, useEffect, useState } from "react";
import App from "./App";
import SchoolGuest from "./SchoolGuest";
import { APP_EDITION } from "./edition";
import LoginScreen from "./LoginScreen";
import { clearAuthSession, getAuthToken } from "./authSession";

export default function AuthGate() {
  const isWechatPreview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get("wechat_preview") === "1";
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [entry, setEntry] = useState<"guest" | "login" | "register">(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has("wechat") || params.has("wechat_error") ? "login" : "guest";
  });
  const [checking, setChecking] = useState(() => Boolean(getAuthToken()));

  useEffect(() => {
    if (!token) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    void fetch("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (cancelled) return;
        if (res.status === 401) {
          clearAuthSession();
          setToken(null);
        }
      })
      .catch(() => {
        // 后端暂时不可用时保留会话，让 App 展示具体连接错误。
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onLoggedIn = useCallback(() => {
    setChecking(false);
    setToken(getAuthToken());
  }, []);

  const onLogout = useCallback(() => {
    clearAuthSession();
    setEntry("guest");
    setToken(null);
  }, []);

  if (isWechatPreview) {
    return (
      <LoginScreen
        edition={APP_EDITION}
        onLoggedIn={() => undefined}
      />
    );
  }

  if (checking) {
    return (
      <div className="flex h-[100dvh] items-center justify-center text-sm text-slate-500">
        正在验证登录状态…
      </div>
    );
  }

  if (!token) {
    if (APP_EDITION === "school" && entry === "guest") {
      return <SchoolGuest onLogin={register => setEntry(register ? "register" : "login")} />;
    }
    return <LoginScreen edition={APP_EDITION} onLoggedIn={onLoggedIn} initialRegister={entry === "register"}
      onGuest={APP_EDITION === "school" ? () => setEntry("guest") : undefined} />;
  }

  return (
    <div className="qp-app-root h-[100dvh] max-h-[100dvh] w-full overflow-hidden">
      <App edition={APP_EDITION} onLogout={onLogout} />
    </div>
  );
}
