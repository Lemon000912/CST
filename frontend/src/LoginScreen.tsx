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
  startWechatLogin,
  type WechatBindingState,
} from "./authApi";
import { PasswordInputWithToggle } from "./PasswordInputWithToggle";
import { APP_NAME } from "./branding";
import { AppLogo } from "./AppLogo";
import { EditionSwitcher } from "./EditionSwitcher";
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

export default function LoginScreen({
  edition,
  onEditionChange,
  onLoggedIn,
}: {
  edition: AppEdition;
  onEditionChange: (edition: AppEdition) => void;
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
  const [wechatPreviewOpen, setWechatPreviewOpen] = useState(false);
  const wechatCallbackHandled = useRef(false);

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
    if (mode !== "login" && !phone.trim()) {
      setErr("请输入手机号");
      return;
    }
    if (
      (mode === "register" || (mode === "wechat" && !wechatNeedsAccountDetails))
      && !/^\d{4,8}$/.test(smsCode.trim())
    ) {
      setErr("请输入短信验证码");
      return;
    }
    if (mode === "wechat" && wechatNeedsAccountDetails && (!username.trim() || password.length < 8)) {
      setErr("请设置新账号用户名和至少 8 位密码");
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
      if (mode === "login") {
        await apiLogin(username, password);
      } else if (mode === "register") {
        await apiRegister(username, password, email, phone, smsCode);
      } else {
        const result = await apiBindWechatPhone({ username, password, email, phone, smsCode });
        if (result.kind === "account_details") {
          setWechatNeedsAccountDetails(true);
          setSmsNotice("手机号验证成功。该号码尚未注册，请设置用户名和密码完成注册");
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

  return (
    <div className="qp-login-shell">
      <div className="qp-welcome-orb opacity-40" aria-hidden />
      <div className="qp-login-card">
        <div className="mb-6 text-center">
          <AppLogo size="lg" className="mx-auto mb-3" />
          <h1 className="text-xl font-semibold tracking-tight text-[var(--t-text-heading)]">{APP_NAME}</h1>
          <p className="mt-1 text-[12px] text-[var(--t-text-dim)]">
            {mode === "wechat" ? "验证手机号后即可完成微信绑定" : edition === "school" ? "学校版" : "企业版"}
          </p>
        </div>

        <div className="mb-4">
          <EditionSwitcher edition={edition} onChange={onEditionChange} />
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
          {(mode !== "wechat" || wechatNeedsAccountDetails) && (
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
          {(mode === "register" || (mode === "wechat" && wechatNeedsAccountDetails)) && (
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
          {mode !== "login" && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--t-text-label)]">手机号（必填）</label>
              <input
                type="tel"
                autoComplete="tel"
                inputMode="numeric"
                value={phone}
                disabled={mode === "wechat" && wechatNeedsAccountDetails}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, "").slice(0, 11));
                  setSmsNotice(null);
                }}
                placeholder="11位手机号"
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
              手机号已验证且尚未注册，请设置账号信息；创建后将自动绑定微信并发放一次注册积分。
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
                onClick={() => {
                  if (isWechatPreview) setWechatPreviewOpen(true);
                  else startWechatLogin();
                }}
                className="flex items-center justify-center gap-2 rounded-xl border border-[#07c160]/30 bg-[#07c160] px-3 py-2.5 text-[13px] font-medium text-white transition hover:bg-[#06ad56] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-[10px]">微</span>
                {wechatAvailable === null ? "正在检测微信登录" : wechatAvailable ? "微信扫码登录" : "微信扫码登录待配置"}
              </button>
            </>
          ) : null}
        </div>

      </div>
      {isWechatPreview && wechatPreviewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white px-6 py-6 text-center shadow-2xl">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#07c160] text-sm font-semibold text-white">
              微信
            </div>
            <h2 className="text-lg font-semibold text-slate-900">微信扫码登录</h2>
            <p className="mt-1 text-xs text-slate-500">使用微信扫一扫，确认登录犀材探索</p>
            <div className="my-5 flex justify-center rounded-xl bg-slate-50 p-3">
              <PreviewQrCode />
            </div>
            <p className="mb-4 text-[11px] text-amber-600">本地界面预览二维码，不可真实扫描</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-600 hover:bg-slate-50"
                onClick={() => setWechatPreviewOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-[#07c160] px-3 py-2.5 text-sm font-medium text-white hover:bg-[#06ad56]"
                onClick={() => {
                  setWechatPreviewOpen(false);
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
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
