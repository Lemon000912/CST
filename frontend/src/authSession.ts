import type { PointBalance } from "./types";
import { getUserId } from "./userId";
import { APP_EDITION } from "./edition";

const TOKEN_KEY = `paper-query-jwt-v2:${APP_EDITION}`;
const PROFILE_KEY = `paper-query-auth-profile-v2:${APP_EDITION}`;

export type AuthProfile = { userId: string; username: string; billing?: PointBalance };

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getAuthProfile(): AuthProfile | null {
  try {
    const j = localStorage.getItem(PROFILE_KEY);
    if (!j) return null;
    const o = JSON.parse(j) as AuthProfile;
    if (o?.userId && o?.username) return o;
  } catch {
    /* ignore */
  }
  return null;
}

export function setAuthSession(token: string, profile: AuthProfile): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* ignore */
  }
}

export function clearAuthSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* ignore */
  }
}

/** 已登录用账户 id，否则沿用匿名设备 id（与旧行为兼容） */
export function getEffectiveUserId(): string {
  return getAuthProfile()?.userId ?? getUserId();
}
