import type { PointBalance } from "./types";
import type { AuthProfile } from "./authSession";
import { setAuthSession } from "./authSession";

type UserDto = { id: string; username: string; billing?: PointBalance };
type AuthJson = { error?: string; code?: string; token?: string; user?: UserDto; billing?: PointBalance };

export type WechatBindingState = {
  requiresPhone: true;
  wechat: { nickname: string; avatarUrl?: string | null };
};

function parseAuthJson(text: string): AuthJson {
  try {
    return JSON.parse(text) as AuthJson;
  } catch {
    return {};
  }
}

function authFailureHint(status: number, bodyText: string): string {
  const t = bodyText.trimStart();
  const looksHtml = t.startsWith("<") || t.includes("<!DOCTYPE");
  if (status === 404 && looksHtml) {
    return "接口返回 404（多为 HTML）：8787 上很可能仍是旧版后端或未启动本项目的 API。请结束占用端口的旧进程后执行 npm run dev（或 npm run dev:server）。";
  }
  if (status === 502 || status === 503) {
    return "无法连接后端 API（代理 502/503）。请先在本机启动犀材后端（npm run dev:server，默认 8787），再刷新页面重试。";
  }
  if (looksHtml) {
    return "响应不是 JSON（常为未走代理或后端返回了网页）。请用 npm run dev 打开前端，并确认 Vite 已将 /api 代理到 127.0.0.1:8787。";
  }
  return "";
}

function persistAuthJson(data: AuthJson, hint = ""): { token: string; user: AuthProfile } {
  if (!data.token || !data.user?.id) {
    throw new Error(["登录响应无效（缺少 token 或 user）", hint].filter(Boolean).join(" — "));
  }
  const profile: AuthProfile = {
    userId: data.user.id,
    username: data.user.username,
    billing: data.billing ?? data.user.billing,
  };
  setAuthSession(data.token, profile);
  return { token: data.token, user: profile };
}

async function postAuth(
  path: "/api/v1/auth/login" | "/api/v1/auth/register",
  body: Record<string, string>,
  action: "登录" | "注册",
): Promise<{ token: string; user: AuthProfile }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/fetch|network|failed|Load failed/i.test(msg)) {
      throw new Error(
        `网络错误（${msg}）：请确认后端已在 127.0.0.1:8787 运行（npm run dev 会同时启动前后端）。`,
      );
    }
    throw e;
  }

  const text = await res.text();
  const data = parseAuthJson(text);
  const hint = authFailureHint(res.status, text);

  if (!res.ok) {
    throw new Error(
      [data.error, `${action}失败（HTTP ${res.status}）`, hint].filter(Boolean).join(" — "),
    );
  }
  return persistAuthJson(data, hint);
}

export async function apiLogin(username: string, password: string): Promise<{ token: string; user: AuthProfile }> {
  return postAuth("/api/v1/auth/login", { username, password }, "登录");
}

export async function apiSendRegisterSmsCode(phone: string): Promise<{ expiresIn: number }> {
  let res: Response;
  try {
    res = await fetch("/api/v1/auth/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phone.trim() }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`验证码发送失败：${message}`);
  }

  const text = await res.text();
  const data = parseAuthJson(text) as AuthJson & { expiresIn?: number };
  if (!res.ok) {
    throw new Error(data.error || `验证码发送失败（HTTP ${res.status}）`);
  }
  return {
    expiresIn: Number.isFinite(Number(data.expiresIn)) ? Number(data.expiresIn) : 300,
  };
}

export async function apiRegister(
  username: string,
  password: string,
  email: string | undefined,
  phone: string,
  smsCode: string,
): Promise<{ token: string; user: AuthProfile }> {
  const body: Record<string, string> = { username, password };
  if (email) body.email = email;
  body.phone = phone.trim();
  body.smsCode = smsCode.trim();
  return postAuth("/api/v1/auth/register", body, "注册");
}

export async function apiIsWechatLoginAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
    if (!response.ok) return false;
    const data = await response.json() as { features?: { wechatLogin?: boolean } };
    return data.features?.wechatLogin === true;
  } catch {
    return false;
  }
}

export async function apiStartWechatLoginEmbed(): Promise<{ authorizationUrl: string }> {
  const response = await fetch("/api/v1/auth/wechat/start?display=embed", {
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  const data = parseAuthJson(text) as AuthJson & { authorizationUrl?: string };
  if (!response.ok) throw new Error(data.error || `微信登录启动失败（HTTP ${response.status}）`);
  const authorizationUrl = String(data.authorizationUrl ?? "");
  let parsed: URL;
  try {
    parsed = new URL(authorizationUrl);
  } catch {
    throw new Error("微信登录二维码地址无效");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("微信登录二维码地址无效");
  return { authorizationUrl: parsed.toString() };
}

export async function apiCompleteWechatLogin(): Promise<
  { kind: "authenticated"; token: string; user: AuthProfile }
  | { kind: "bind"; state: WechatBindingState }
> {
  const response = await fetch("/api/v1/auth/wechat/session", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  const data = parseAuthJson(text) as AuthJson & Partial<WechatBindingState>;
  if (!response.ok) throw new Error(data.error || `微信登录失败（HTTP ${response.status}）`);
  if (data.requiresPhone === true && data.wechat) {
    return { kind: "bind", state: data as WechatBindingState };
  }
  const authenticated = persistAuthJson(data);
  return { kind: "authenticated", ...authenticated };
}

export async function apiSendWechatBindSmsCode(phone: string): Promise<{ expiresIn: number }> {
  const response = await fetch("/api/v1/auth/wechat/sms/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: phone.trim() }),
  });
  const text = await response.text();
  const data = parseAuthJson(text) as AuthJson & { expiresIn?: number };
  if (!response.ok) throw new Error(data.error || `验证码发送失败（HTTP ${response.status}）`);
  return { expiresIn: Number(data.expiresIn) || 300 };
}

export async function apiBindWechatPhone(input: {
  phone: string;
  smsCode: string;
  username?: string;
  password?: string;
  email?: string;
}): Promise<
  { kind: "authenticated"; token: string; user: AuthProfile; accountCreated: boolean }
  | { kind: "account_details" }
> {
  const response = await fetch("/api/v1/auth/wechat/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: input.phone.trim(),
      smsCode: input.smsCode.trim(),
      username: input.username?.trim() || "",
      password: input.password || "",
      email: input.email?.trim() || "",
    }),
  });
  const text = await response.text();
  const data = parseAuthJson(text) as AuthJson & {
    accountCreated?: boolean;
    requiresAccountDetails?: boolean;
  };
  if (response.status === 428 && data.requiresAccountDetails) {
    return { kind: "account_details" };
  }
  if (!response.ok) throw new Error(data.error || `微信绑定失败（HTTP ${response.status}）`);
  return {
    kind: "authenticated",
    ...persistAuthJson(data),
    accountCreated: data.accountCreated === true,
  };
}
