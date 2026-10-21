export const SCI99_LOGIN_URL = "https://ucenter.sci99.com/#/login";

const visible = (locator) => locator.filter({ visible: true }).first();
const navigationChanged = (error) => /Execution context was destroyed|Cannot find context|interrupted by another navigation/i.test(String(error?.message ?? ""));

/**
 * Log in through SCI99's account/password form and verify the user's workbench.
 * The caller owns the Playwright page/context. No credentials/state are saved.
 * @param {import('playwright').Page} page
 * @param {{account: string, password: string, timeoutMs?: number,
 *   loginTimeoutMs?: number, onStatus?: (message: string) => void}} options
 */
export async function loginSci99(page, options = {}) {
  const account = String(options.account ?? "").trim();
  const password = String(options.password ?? "");
  if (!account || !password) throw new Error("请配置 SCI99_ACCOUNT 和 SCI99_PASSWORD。");
  const timeoutMs = timeout(options.timeoutMs);
  const loginTimeoutMs = timeout(options.loginTimeoutMs);
  const status = options.onStatus ?? (() => {});
  const accountTab = visible(page.getByText("账号密码登录", { exact: true }));
  const anyGreeting = visible(page.getByRole("button", { name: /^您好，/ }));
  const greeting = visible(page.getByRole("button", { name: `您好，${account}`, exact: true }));
  const workbench = visible(page.getByRole("menuitem", { name: /^工作台(?:\s|$)/ }));
  const loggedIn = async () => {
    const url = new URL(page.url());
    return url.origin === "https://ucenter.sci99.com" && !/^#\/login(?:[/?]|$)/.test(url.hash)
      && await greeting.isVisible() && await workbench.isVisible();
  };

  await page.goto(SCI99_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await accountTab.or(anyGreeting).first().waitFor({ state: "visible", timeout: timeoutMs });
  if (await anyGreeting.isVisible()) {
    if (!await greeting.isVisible()) throw new Error("卓创资讯当前会话与配置账号不一致，请先退出原账号。");
    // The SPA may render the greeting before its menu or route is ready.
    await workbench.waitFor({ state: "visible", timeout: timeoutMs });
    if (await loggedIn()) return { loggedIn: true, reusedSession: true };
  }

  await accountTab.click({ timeout: timeoutMs });
  await visible(page.getByRole("textbox", { name: "请输入账号", exact: true })).fill(account, { timeout: timeoutMs });
  await visible(page.getByRole("textbox", { name: "请输入密码", exact: true })).fill(password, { timeout: timeoutMs });

  // Element UI hides its original input from accessibility (aria-hidden).
  // Read it by its component selector; interact through the visible icon.
  const agreement = page.locator('.el-checkbox__input input[type="checkbox"]').first();
  if (!await agreement.isChecked({ timeout: timeoutMs })) {
    await visible(page.locator(".el-checkbox__inner")).click({ timeout: timeoutMs });
  }
  if (!await agreement.isChecked({ timeout: timeoutMs })) throw new Error("卓创资讯协议勾选未生效，登录未提交。");
  status("已填写账号并勾选用户协议和隐私政策。");
  await visible(page.getByRole("button", { name: "登录", exact: true })).click({ timeout: timeoutMs });
  status("已提交登录，等待卓创资讯用户中心确认会话。");

  const deadline = Date.now() + loginTimeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("卓创资讯登录窗口已关闭。");
    try {
      if (await loggedIn()) return { loggedIn: true, reusedSession: false };
      const failure = page.getByText(
        /用户名或密码错误|账号或密码错误|账号或密码不正确|密码错误|密码不正确|用户名不存在|用户不存在|账号不存在|账号已锁定|登录失败/,
      ).filter({ visible: true });
      if (await failure.count()) throw new Error("卓创资讯登录失败，请检查账号密码或账户状态。");
    } catch (error) {
      if (!navigationChanged(error)) throw error;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("卓创资讯自动登录超时：网站未确认登录成功。");
}

function timeout(value) {
  if (value == null) return 30_000;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) throw new Error("卓创资讯登录超时参数必须为正数。");
  return number;
}
