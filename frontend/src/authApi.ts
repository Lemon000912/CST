import type { PointBalance } from "./types";
import type { AuthProfile } from "./authSession";
import { setAuthSession } from "./authSession";
import { appEditionHeader } from "./edition";

type UserDto = { id: string; username: string; billing?: PointBalance };
type AuthJson = { error?: string; token?: string; user?: UserDto; billing?: PointBalance };

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

async function postAuth(
  path: "/api/v1/auth/login" | "/api/v1/auth/register",
  body: Record<string, string>,
  action: "登录" | "注册",
): Promise<{ token: string; user: AuthProfile }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...appEditionHeader() },
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
  if (!data.token || !data.user?.id) {
    throw new Error(
      [`${action}响应无效（缺少 token 或 user）`, hint].filter(Boolean).join(" — "),
    );
  }
  const profile: AuthProfile = {
    userId: data.user.id,
    username: data.user.username,
    billing: data.billing ?? data.user.billing,
  };
  setAuthSession(data.token, profile);
  return { token: data.token, user: profile };
}

export async function apiLogin(username: string, password: string): Promise<{ token: string; user: AuthProfile }> {
  return postAuth("/api/v1/auth/login", { username, password }, "登录");
}

export async function apiRegister(
  username: string,
  password: string,
  email: string | undefined,
  phone: string,
): Promise<{ token: string; user: AuthProfile }> {
  const body: Record<string, string> = { username, password };
  if (email) body.email = email;
  body.phone = phone.trim();
  return postAuth("/api/v1/auth/register", body, "注册");
}
