import { randomUUID } from "node:crypto";
import { hashUserPassword } from "./auth.js";
import { createUserRecord, findUserByUsernameKey, normalizeUsernameKey } from "./db.js";

const USERNAME_RE = /^[a-z0-9_]{2,32}$/;

/**
 * 当 `SEED_DEV_ADMIN=1` 时：若库中尚无该用户名，则创建测试管理员（与正式「角色」无关，仅便于登录联调）。
 * 默认用户名 `admin`、默认密码 `TestAdmin_888`，可用 `DEV_ADMIN_USERNAME` / `DEV_ADMIN_PASSWORD` 覆盖。
 * 生产环境请勿开启。
 */
export async function seedDevAdminIfEnabled() {
  if (String(process.env.SEED_DEV_ADMIN ?? "").trim() !== "1") return;
  if (String(process.env.NODE_ENV ?? "").toLowerCase() === "production") {
    console.warn("[dev-admin] SEED_DEV_ADMIN is disabled in production");
    return;
  }

  const username = normalizeUsernameKey(process.env.DEV_ADMIN_USERNAME ?? "admin");
  if (!USERNAME_RE.test(username)) {
    console.warn("[dev-admin] DEV_ADMIN_USERNAME 不符合规则（2～32 位 a-z0-9_），已跳过");
    return;
  }

  const password = String(process.env.DEV_ADMIN_PASSWORD ?? "");
  if (!password) {
    console.warn("[dev-admin] DEV_ADMIN_PASSWORD must be explicitly configured");
    return;
  }
  if (password.length < 8 || password.length > 128) {
    console.warn("[dev-admin] DEV_ADMIN_PASSWORD 长度须为 8～128，已跳过");
    return;
  }

  const existing = await findUserByUsernameKey(username);
  if (existing) {
    console.log("[dev-admin] 用户已存在，跳过创建:", username);
    return;
  }

  const id = randomUUID();
  const passwordHash = await hashUserPassword(password);
  await createUserRecord(id, username, passwordHash);
  const shown = process.env.DEV_ADMIN_PASSWORD ? "（自定义，未在日志中打印）" : "TestAdmin_888（默认，见 .env.example）";
  console.log("[dev-admin] 已创建测试账号 — 用户名:", username, "| 密码:", shown);
}
