import { useCallback, useEffect, useState } from "react";
import App from "./App";
import type { AppEdition } from "./edition";
import { getAppEdition, setAppEdition } from "./edition";
import LoginScreen from "./LoginScreen";
import { clearAuthSession, getAuthToken } from "./authSession";

export default function AuthGate() {
  const isWechatPreview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get("wechat_preview") === "1";
  const [edition, setEditionState] = useState<AppEdition>(() => getAppEdition());
  const [token, setToken] = useState<string | null>(() => getAuthToken());
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
    setToken(null);
  }, []);

  const onEditionChange = useCallback((nextEdition: AppEdition) => {
    setAppEdition(nextEdition);
    setEditionState(nextEdition);
  }, []);

  if (isWechatPreview) {
    return (
      <LoginScreen
        edition={edition}
        onEditionChange={onEditionChange}
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
    return <LoginScreen edition={edition} onEditionChange={onEditionChange} onLoggedIn={onLoggedIn} />;
  }

  return (
    <div className="qp-app-root h-[100dvh] max-h-[100dvh] w-full overflow-hidden">
      <App edition={edition} onEditionChange={onEditionChange} onLogout={onLogout} />
    </div>
  );
}
