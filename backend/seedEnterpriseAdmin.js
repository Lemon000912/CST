import { randomUUID } from "node:crypto";
import { hashUserPassword } from "./auth.js";
import {
  createUserRecord,
  findUserByUsernameKey,
  normalizeUsernameKey,
} from "./db.js";

const USERNAME_RE = /^[a-z0-9_]{2,32}$/;
const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "admin123";

/**
 * Ensure the enterprise instance has its initial administrator account.
 * Existing accounts are never overwritten on restart.
 */
export async function seedEnterpriseAdminIfEnabled() {
  if (String(process.env.APP_EDITION ?? "").trim().toLowerCase() !== "enterprise") return;

  const username = normalizeUsernameKey(process.env.ENTERPRISE_ADMIN_USERNAME ?? DEFAULT_USERNAME);
  const password = String(process.env.ENTERPRISE_ADMIN_PASSWORD ?? DEFAULT_PASSWORD);
  if (!USERNAME_RE.test(username) || password.length < 8 || password.length > 128) {
    throw new Error("企业版默认管理员配置无效：用户名须为 2～32 位，密码须为 8～128 位");
  }

  const existing = await findUserByUsernameKey(username);
  if (existing) {
    console.log("[enterprise-admin] 管理员账号已存在，跳过创建:", username);
    return;
  }

  await createUserRecord(randomUUID(), username, await hashUserPassword(password));
  console.log("[enterprise-admin] 已创建默认管理员账号:", username);
}
