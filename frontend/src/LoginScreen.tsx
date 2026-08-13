import { useState } from "react";
import { LOADING_AUTH } from "./loadingCopy";
import { apiLogin, apiRegister } from "./authApi";
import { PasswordInputWithToggle } from "./PasswordInputWithToggle";
import { APP_NAME } from "./branding";
import { AppLogo } from "./AppLogo";

export default function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (mode === "register" && !phone.trim()) {
      setErr("请输入手机号");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") await apiLogin(username, password);
      else await apiRegister(username, password, email, phone);
      onLoggedIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qp-login-shell">
      <div className="qp-welcome-orb opacity-40" aria-hidden />
      <div className="qp-login-card">
        <div className="mb-6 text-center">
          <AppLogo size="lg" className="mx-auto mb-3" />
          <h1 className="text-xl font-semibold tracking-tight text-[var(--t-text-heading)]">{APP_NAME}</h1>
          <p className="mt-1 text-[12px] text-[var(--t-text-dim)]">请登录或注册后使用（会话与侧栏设置仍保存在本机）</p>
        </div>

        <div className="mb-4 flex rounded-xl border border-[color:var(--t-br08)] bg-[var(--t-muted)] p-0.5 text-[13px]">
          <button
            type="button"
            className={`flex-1 rounded-lg py-2 font-medium transition ${
              mode === "login"
                ? "bg-[var(--t-surface)] text-[var(--t-text)]"
                : "text-[var(--t-text-muted)] hover:text-[var(--t-text)]"
            }`}
            onClick={() => setMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            className={`flex-1 rounded-lg py-2 font-medium transition ${
              mode === "register"
                ? "bg-[var(--t-surface)] text-[var(--t-text)]"
                : "text-[var(--t-text-muted)] hover:text-[var(--t-text)]"
            }`}
            onClick={() => setMode("register")}
          >
            注册
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">用户名</label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="小写字母、数字、下划线，2～32 位"
              className="qp-field"
            />
          </div>
          {mode === "register" && (
            <>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">邮箱（可选）</label>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="example@email.com"
                  className="qp-field"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">手机号（必填）</label>
                <input
                  type="tel"
                  autoComplete="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="11位手机号"
                  required
                  aria-required="true"
                  pattern="1[3-9][0-9]{9}"
                  maxLength={11}
                  className="qp-field"
                />
              </div>
            </>
          )}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">密码</label>
            <PasswordInputWithToggle
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "至少 8 位" : ""}
              className="qp-field"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
          {err ? <p className="text-[12px] text-[var(--t-error)]">{err}</p> : null}
          <button type="button" disabled={busy} onClick={() => void submit()} className="qp-btn-primary mt-1">
            {busy ? LOADING_AUTH : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </div>

      </div>
    </div>
  );
}
