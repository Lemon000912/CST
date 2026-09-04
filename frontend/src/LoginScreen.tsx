import { useEffect, useRef, useState } from "react";
import { LOADING_AUTH } from "./loadingCopy";
import {
  apiBindWechatPhone,
  apiCompleteWechatLogin,
  apiIsWechatLoginAvailable,
  apiLogin,
  apiRegister,
  apiSendRegisterSmsCode,
  apiSendWechatBindSmsCode,
  apiStartWechatLoginEmbed,
  type WechatBindingState,
} from "./authApi";
import { PasswordInputWithToggle } from "./PasswordInputWithToggle";
import { APP_NAME } from "./branding";
import { AppLogo } from "./AppLogo";
import type { AppEdition } from "./edition";

function PreviewQrCode() {
  const size = 25;
  const finder = (x: number, y: number, left: number, top: number) => {
    const dx = x - left;
    const dy = y - top;
    if (dx < 0 || dx > 6 || dy < 0 || dy > 6) return false;
    return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
  };
  return (
    <div
      className="grid h-48 w-48 bg-white p-3 shadow-inner"
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      aria-label="本地预览二维码，不可扫描"
    >
      {Array.from({ length: size * size }, (_, index) => {
        const x = index % size;
        const y = Math.floor(index / size);
        const isFinder = finder(x, y, 1, 1) || finder(x, y, 17, 1) || finder(x, y, 1, 17);
        const isData = ((x * 17 + y * 31 + x * y * 7) % 11) < 5;
        return <span key={index} className={isFinder || isData ? "bg-slate-950" : "bg-white"} />;
      })}
    </div>
  );
}

type WxLoginOptions = {
  self_redirect: boolean;
  id: string;
  appid: string;
  scope: string;
  redirect_uri: string;
  state: string;
  style: string;
  href: string;
};

declare global {
  interface Window {
    WxLogin?: new (options: WxLoginOptions) => unknown;
  }
}

function WechatQrEmbed({ authorizationUrl, onError }: { authorizationUrl: string; onError: (message: string) => void }) {
  useEffect(() => {
    let cancelled = false;
    const containerId = "wechat-login-qr-container";
    const renderQrCode = () => {
      if (cancelled) return;
      const WxLogin = window.WxLogin;
      const container = document.getElementById(containerId);
      if (!WxLogin || !container) {
        onError("微信二维码组件加载失败，请稍后重试");
        return;
      }
      try {
        const url = new URL(authorizationUrl);
        container.replaceChildren();
        new WxLogin({
          self_redirect: false,
          id: containerId,
          appid: url.searchParams.get("appid") || "",
          scope: url.searchParams.get("scope") || "snsapi_login",
          redirect_uri: url.searchParams.get("redirect_uri") || "",
          state: url.searchParams.get("state") || "",
          style: "black",
          href: "",
        });
      } catch {
        onError("微信二维码地址无效，请关闭后重试");
      }
    };

    const scriptId = "wechat-wxlogin-script";
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (window.WxLogin) {
      renderQrCode();
    } else if (existing) {
      existing.addEventListener("load", renderQrCode, { once: true });
      existing.addEventListener("error", () => onError("微信二维码组件加载失败，请稍后重试"), { once: true });
    } else {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js";
      script.async = true;
      script.addEventListener("load", renderQrCode, { once: true });
      script.addEventListener("error", () => onError("微信二维码组件加载失败，请稍后重试"), { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      existing?.removeEventListener("load", renderQrCode);
      document.getElementById(containerId)?.replaceChildren();
    };
  }, [authorizationUrl, onError]);

  return <div id="wechat-login-qr-container" className="wechat-login-qr-container" aria-label="微信扫码登录二维码" />;
}

export default function LoginScreen({
  edition,
  onLoggedIn,
}: {
  edition: AppEdition;
  onLoggedIn: () => void;
}) {
  const isWechatPreview = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get("wechat_preview") === "1";
  const [mode, setMode] = useState<"login" | "register" | "wechat">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsCountdown, setSmsCountdown] = useState(0);
  const [smsNotice, setSmsNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [wechatAvailable, setWechatAvailable] = useState<boolean | null>(null);
  const [wechatBinding, setWechatBinding] = useState<WechatBindingState | null>(null);
  const [wechatNeedsAccountDetails, setWechatNeedsAccountDetails] = useState(false);
  const [wechatQrOpen, setWechatQrOpen] = useState(false);
  const [wechatQrUrl, setWechatQrUrl] = useState<string | null>(null);
  const [wechatQrBusy, setWechatQrBusy] = useState(false);
  const [wechatQrError, setWechatQrError] = useState<string | null>(null);
  const wechatCallbackHandled = useRef(false);
  const isSchool = edition === "school";

  useEffect(() => {
    if (smsCountdown <= 0) return;
    const timer = window.setInterval(() => {
      setSmsCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [smsCountdown]);

  useEffect(() => {
    if (isWechatPreview) {
      setWechatAvailable(true);
      return;
    }
    void apiIsWechatLoginAvailable().then(setWechatAvailable);
  }, [isWechatPreview]);

  useEffect(() => {
    if (wechatCallbackHandled.current) return;
    const url = new URL(window.location.href);
    const completed = url.searchParams.get("wechat") === "complete";
    const callbackError = url.searchParams.get("wechat_error");
    if (!completed && !callbackError) return;
    wechatCallbackHandled.current = true;
    url.searchParams.delete("wechat");
    url.searchParams.delete("wechat_error");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);

    if (callbackError) {
      const messages: Record<string, string> = {
        cancelled: "你取消了微信授权，请重新扫码",
        invalid_state: "微信登录状态已失效，请重新扫码",
        "wechat-provider-failed": "微信授权失败，请重新扫码",
        "wechat-provider-unavailable": "微信登录服务暂时不可用，请稍后重试",
      };
      setErr(messages[callbackError] || "微信登录失败，请重新扫码");
      return;
    }

    setBusy(true);
    void apiCompleteWechatLogin()
      .then((result) => {
        if (result.kind === "authenticated") {
          onLoggedIn();
          return;
        }
        setWechatBinding(result.state);
        setWechatNeedsAccountDetails(false);
        setUsername("");
        setPassword("");
        setEmail("");
        setPhone("");
        setSmsCode("");
        setSmsNotice(null);
        setMode("wechat");
        setErr(null);
      })
      .catch((error) => setErr(error instanceof Error ? error.message : "微信登录失败"))
      .finally(() => setBusy(false));
  }, [onLoggedIn]);

  const sendSmsCode = async () => {
    setErr(null);
    setSmsNotice(null);
    const normalizedPhone = phone.trim();
    if (!/^1[3-9]\d{9}$/.test(normalizedPhone)) {
      setErr("请输入正确的11位中国大陆手机号");
      return;
    }
    setSmsBusy(true);
    try {
      if (isWechatPreview && mode === "wechat") {
        setSmsCountdown(60);
        setSmsNotice("本地预览模式：未发送真实短信，已填入演示验证码");
        setSmsCode("123456");
        return;
      }
      const result = mode === "wechat"
        ? await apiSendWechatBindSmsCode(normalizedPhone)
        : await apiSendRegisterSmsCode(normalizedPhone);
      setSmsCountdown(60);
      setSmsNotice(`验证码已发送，有效期约 ${Math.ceil(result.expiresIn / 60)} 分钟`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "验证码发送失败");
    } finally {
      setSmsBusy(false);
    }
  };

  const submit = async () => {
    setErr(null);
    if ((mode !== "login" || isSchool) && !phone.trim()) {
      setErr(mode === "login" ? "请输入手机号或管理员账号" : "请输入手机号");
      return;
    }
    if (
      (mode === "register" || (mode === "wechat" && !wechatNeedsAccountDetails))
      && !/^\d{4,8}$/.test(smsCode.trim())
    ) {
      setErr("请输入短信验证码");
      return;
    }
    if (
      mode === "wechat"
      && wechatNeedsAccountDetails
      && ((isSchool ? !phone.trim() : !username.trim()) || password.length < 8)
    ) {
      setErr(isSchool ? "请设置至少 8 位登录密码" : "请设置新账号用户名和至少 8 位密码");
      return;
    }
    if (isWechatPreview && mode === "wechat") {
      if (!wechatNeedsAccountDetails) {
        setWechatNeedsAccountDetails(true);
        setSmsNotice("本地预览模式：模拟手机号验证成功");
        return;
      }
      setErr("本地界面预览已完成；预览模式不会创建账号或写入数据库");
      return;
    }
    setBusy(true);
    try {
      const accountName = isSchool ? phone.trim() : username;
      if (mode === "login") {
        await apiLogin(accountName, password);
      } else if (mode === "register") {
        await apiRegister(accountName, password, isSchool ? undefined : email, phone, smsCode);
      } else {
        const result = await apiBindWechatPhone({
          username: accountName,
          password,
          email: isSchool ? undefined : email,
          phone,
          smsCode,
        });
        if (result.kind === "account_details") {
          setWechatNeedsAccountDetails(true);
          setSmsNotice(isSchool
            ? "手机号验证成功。该号码尚未注册，请设置登录密码完成注册"
            : "手机号验证成功。该号码尚未注册，请设置用户名和密码完成注册");
          return;
        }
      }
      onLoggedIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const openWechatQr = async () => {
    setErr(null);
    setWechatQrError(null);
    setWechatQrUrl(null);
    setWechatQrOpen(true);
    if (isWechatPreview) return;
    setWechatQrBusy(true);
    try {
      const result = await apiStartWechatLoginEmbed();
      setWechatQrUrl(result.authorizationUrl);
    } catch (error) {
      setWechatQrError(error instanceof Error ? error.message : "微信登录启动失败");
    } finally {
      setWechatQrBusy(false);
    }
  };

  return (
    <div className="qp-login-shell">
      <div className="qp-welcome-orb opacity-40" aria-hidden />
      <div className="qp-login-card">
        <div className="mb-6 text-center">
          <AppLogo size="lg" className="mx-auto mb-3" />
          <h1 className="text-xl font-semibold tracking-tight text-[var(--t-text-heading)]">{APP_NAME}</h1>
          <p className="mt-1 text-[12px] text-[var(--t-text-dim)]">
            {mode === "wechat" ? "验证手机号后即可完成微信绑定" : edition === "school" ? "校园版" : "企业版"}
          </p>
        </div>

        {mode === "wechat" ? (
          <div className="mb-4 rounded-xl border border-[#07c160]/25 bg-[#07c160]/10 px-3 py-3 text-[12px] text-[var(--t-text)]">
            <div className="flex items-center justify-between gap-3">
              <span>微信用户：{wechatBinding?.wechat.nickname || "已授权"}</span>
              <button
                type="button"
                className="text-[11px] text-[var(--t-text-muted)] hover:text-[var(--t-text)]"
                onClick={() => {
                  setMode("login");
                  setWechatBinding(null);
                  setWechatNeedsAccountDetails(false);
                  setErr(null);
                }}
              >
                返回账号登录
              </button>
            </div>
          </div>
        ) : (
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
        )}

        <div className="flex flex-col gap-3">
          {!isSchool && (mode !== "wechat" || wechatNeedsAccountDetails) && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">
                {mode === "wechat" ? "设置新账号用户名" : "用户名"}
              </label>
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="小写字母、数字、下划线，2～32 位"
                className="qp-field"
              />
            </div>
          )}
          {!isSchool && (mode === "register" || (mode === "wechat" && wechatNeedsAccountDetails)) && (
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
          )}
          {(mode !== "login" || isSchool) && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">
                {isSchool && mode === "login" ? "手机号 / 管理员账号" : "手机号（必填）"}
              </label>
              <input
                type={isSchool && mode === "login" ? "text" : "tel"}
                autoComplete={isSchool && mode === "login" ? "username" : "tel"}
                inputMode={isSchool && mode === "login" ? "text" : "numeric"}
                value={phone}
                disabled={mode === "wechat" && wechatNeedsAccountDetails}
                onChange={(e) => {
                  const value = isSchool && mode === "login"
                    ? e.target.value.slice(0, 64)
                    : e.target.value.replace(/\D/g, "").slice(0, 11);
                  setPhone(value);
                  setSmsNotice(null);
                }}
                placeholder={isSchool && mode === "login" ? "11位手机号，管理员可输入 admin" : "11位手机号"}
                required
                aria-required="true"
                pattern="1[3-9][0-9]{9}"
                maxLength={11}
                className="qp-field disabled:cursor-not-allowed disabled:opacity-70"
              />
            </div>
          )}
          {mode === "wechat" && wechatNeedsAccountDetails ? (
            <p className="rounded-lg bg-[#07c160]/10 px-3 py-2 text-[11px] text-[var(--t-text-muted)]">
              {isSchool
                ? "手机号已验证且尚未注册，请设置登录密码；创建后将自动绑定微信并发放一次注册积分。"
                : "手机号已验证且尚未注册，请设置账号信息；创建后将自动绑定微信并发放一次注册积分。"}
            </p>
          ) : null}
          {mode !== "login" && !(mode === "wechat" && wechatNeedsAccountDetails) && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">短信验证码（必填）</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  placeholder="请输入验证码"
                  required
                  aria-required="true"
                  maxLength={8}
                  className="qp-field min-w-0 flex-1"
                />
                <button
                  type="button"
                  disabled={busy || smsBusy || smsCountdown > 0}
                  onClick={() => void sendSmsCode()}
                  className="shrink-0 rounded-xl border border-[color:var(--t-br10)] px-3 text-[12px] font-medium text-[var(--t-text)] transition hover:bg-[var(--t-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {smsBusy ? "发送中" : smsCountdown > 0 ? `${smsCountdown}秒` : "获取验证码"}
                </button>
              </div>
              {smsNotice ? <p className="mt-1 text-[11px] text-[var(--t-text-muted)]">{smsNotice}</p> : null}
            </div>
          )}
          {(mode !== "wechat" || wechatNeedsAccountDetails) && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">
                {mode === "wechat" ? "设置登录密码" : "密码"}
              </label>
              <PasswordInputWithToggle
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "login" ? "" : "至少 8 位"}
                className="qp-field"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
          )}
          {err ? <p className="text-[12px] text-[var(--t-error)]">{err}</p> : null}
          <button type="button" disabled={busy} onClick={() => void submit()} className="qp-btn-primary mt-1">
            {busy
              ? LOADING_AUTH
              : mode === "login"
                ? "登录"
                : mode === "register"
                  ? "注册并登录"
                  : wechatNeedsAccountDetails
                    ? "创建账号并绑定微信"
                    : "验证手机号并继续"}
          </button>

          {mode !== "wechat" ? (
            <>
              <div className="flex items-center gap-3 py-1 text-[10px] text-[var(--t-text-dim)]">
                <span className="h-px flex-1 bg-[var(--t-br08)]" />
                <span>其他登录方式</span>
                <span className="h-px flex-1 bg-[var(--t-br08)]" />
              </div>
              <button
                type="button"
                disabled={busy || wechatAvailable !== true}
                onClick={() => void openWechatQr()}
                className="flex items-center justify-center gap-2 rounded-xl border border-[#07c160]/30 bg-[#07c160] px-3 py-2.5 text-[13px] font-medium text-white transition hover:bg-[#06ad56] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-[10px]">微</span>
                {wechatAvailable === null ? "正在检测微信登录" : wechatAvailable ? "微信扫码登录" : "微信扫码登录待配置"}
              </button>
            </>
          ) : null}
        </div>

        {wechatQrOpen ? (
          <div className="absolute inset-0 z-20 flex flex-col overflow-y-auto rounded-xl bg-[var(--t-surface)] px-6 py-6 text-center sm:px-8">
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-xs text-[var(--t-text-muted)] transition hover:bg-[var(--t-muted)] hover:text-[var(--t-text)]"
                onClick={() => {
                  setWechatQrOpen(false);
                  setWechatQrUrl(null);
                  setWechatQrError(null);
                }}
              >
                ← 返回
              </button>
              <span className="rounded-full bg-[#07c160]/10 px-2.5 py-1 text-[11px] font-medium text-[#07a950]">微信安全登录</span>
            </div>

            <p className="mt-4 text-sm text-[var(--t-text-muted)]">使用微信扫一扫，确认登录{APP_NAME}</p>

            <div className="my-4 flex min-h-[268px] flex-1 items-center justify-center overflow-hidden rounded-xl border border-[color:var(--t-br08)] bg-white p-3">
              {isWechatPreview ? (
                <PreviewQrCode />
              ) : wechatQrBusy ? (
                <p className="text-sm text-slate-500">正在生成二维码…</p>
              ) : wechatQrError ? (
                <div className="px-4 text-sm text-red-600">
                  <p>{wechatQrError}</p>
                  <button type="button" className="mt-3 text-xs text-[#07a950] underline" onClick={() => void openWechatQr()}>
                    重新加载
                  </button>
                </div>
              ) : wechatQrUrl ? (
                <WechatQrEmbed authorizationUrl={wechatQrUrl} onError={setWechatQrError} />
              ) : null}
            </div>

            <p className={`text-[11px] ${isWechatPreview ? "text-amber-600" : "text-[var(--t-text-dim)]"}`}>
              {isWechatPreview ? "本地界面预览二维码，不可真实扫描" : "二维码由微信开放平台提供，请使用本人微信扫码"}
            </p>
            {isWechatPreview ? (
              <button
                type="button"
                className="mt-3 w-full rounded-xl bg-[#07c160] px-3 py-2.5 text-sm font-medium text-white transition hover:bg-[#06ad56]"
                onClick={() => {
                  setWechatQrOpen(false);
                  setWechatBinding({
                    requiresPhone: true,
                    wechat: { nickname: "微信预览用户", avatarUrl: null },
                  });
                  setWechatNeedsAccountDetails(false);
                  setPhone("13800138000");
                  setSmsCode("123456");
                  setUsername("");
                  setPassword("");
                  setEmail("");
                  setSmsNotice("本地预览模式：手机号和验证码为演示数据");
                  setErr(null);
                  setMode("wechat");
                }}
              >
                模拟扫码成功
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
