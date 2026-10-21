export const OILCHEM_LOGIN_URL = "https://passport.oilchem.net/member/login/index";

const visible = (locator) => locator.filter({ visible: true }).first();
const navigationChanged = (error) => /Execution context was destroyed|Cannot find context|interrupted by another navigation/i.test(String(error?.message ?? ""));

/**
 * Log in to Oilchem using its account form. The caller owns the page/context.
 * Checks both the agreement and remember-password boxes, then verifies the
 * member-center and logout links. No credentials or browser state are written.
 * @param {import('playwright').Page} page
 * @param {{account: string, password: string, timeoutMs?: number,
 *   loginTimeoutMs?: number, onStatus?: (message: string) => void}} options
 */
export async function loginOilchem(page, options = {}) {
  const account = String(options.account ?? "").trim();
  const password = String(options.password ?? "");
  if (!account || !password) throw new Error("请配置 OILCHEM_ACCOUNT 和 OILCHEM_PASSWORD。");
  const timeoutMs = timeout(options.timeoutMs);
  const loginTimeoutMs = timeout(options.loginTimeoutMs);
  const status = options.onStatus ?? (() => {});
  const logout = visible(page.getByRole("link", { name: /退出/ }));
  const memberCenter = visible(page.getByRole("link", { name: /会员中心/ }));
  const loggedIn = async () => await logout.isVisible() && await memberCenter.isVisible();

  await page.goto(OILCHEM_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const accountTab = visible(page.getByText("账号登录", { exact: true }));
  await accountTab.or(logout).first().waitFor({ state: "visible", timeout: timeoutMs });
  if (await loggedIn()) return { loggedIn: true, reusedSession: true };

  await accountTab.click({ timeout: timeoutMs });
  await visible(page.getByRole("textbox", { name: "请输入用户名", exact: true }))
    .fill(account, { timeout: timeoutMs });
  await visible(page.getByRole("textbox", { name: "请输入密码", exact: true }))
    .fill(password, { timeout: timeoutMs });

  // Account mode has two visible checkboxes: agreement, then remember password.
  // check() is idempotent, including when the site's agreement starts checked.
  await visible(page.getByRole("checkbox")).check({ timeout: timeoutMs });
  await page.locator("#remberId").check({ timeout: timeoutMs });
  status("已填写账号并勾选用户协议、隐私政策及记住密码。");
  await visible(page.getByRole("button", { name: /^登\s*录$/ })).click({ timeout: timeoutMs });
  status("已提交登录，等待隆众资讯确认会话。");

  const deadline = Date.now() + loginTimeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("隆众资讯登录窗口已关闭。");
    try {
      if (await loggedIn()) return { loggedIn: true, reusedSession: false };
      const failure = page.getByText(
        /用户名或密码错误|账号或密码错误|账户或密码错误|密码错误|密码不正确|用户名不存在|用户不存在|账号不存在|账户不存在|账号已锁定|账户已锁定|登录失败/,
      ).filter({ visible: true });
      if (await failure.count()) throw new Error("隆众资讯登录失败，请检查账号密码或账户状态。");
    } catch (error) {
      if (!navigationChanged(error)) throw error;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("隆众资讯自动登录超时：网站未确认登录成功。");
}

function timeout(value) {
  if (value == null) return 30_000;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) throw new Error("隆众资讯登录超时参数必须为正数。");
  return number;
}
