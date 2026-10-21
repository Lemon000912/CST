/** Eastmoney account login. The caller owns the Playwright page/context. */
export const EASTMONEY_LOGIN_URL = "https://passport2.eastmoney.com/pub/login";

const visible = (scope, selector) => scope.locator(`${selector}:visible`);
const visibleText = (scope, text) => scope.getByText(text, { exact: true }).filter({ visible: true }).first();
const logoutLink = (page) => page.getByRole("link", { name: "退出", exact: true }).filter({ visible: true }).first();
const isNavigationChange = (error) => /Execution context was destroyed|Cannot find context|Frame (?:was|has been) detached|frame was detached|frame has been detached|interrupted by another navigation/i.test(String(error?.message ?? ""));

/**
 * Log in using the site's normal UI and verify the personal-center logout link.
 * Click-to-verify challenges run automatically; unresolved challenges fail on timeout.
 * Does not persist passwords, cookies, screenshots, or browser profiles.
 *
 * @param {import('playwright').Page} page
 * @param {{account: string, password: string, timeoutMs?: number,
 *   verificationTimeoutMs?: number, onStatus?: (message: string) => void}} options
 */
export async function loginEastmoney(page, options = {}) {
  const account = String(options.account ?? "").trim();
  const password = String(options.password ?? "");
  if (!account || !password) {
    throw new Error("请配置 EASTMONEY_ACCOUNT 和 EASTMONEY_PASSWORD。");
  }
  const timeoutMs = positiveTimeout(options.timeoutMs, 30_000);
  const verificationTimeoutMs = positiveTimeout(options.verificationTimeoutMs, 30_000);
  const status = options.onStatus ?? (() => {});
  const logout = logoutLink(page);

  await page.goto(EASTMONEY_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // An existing session may redirect directly to the personal center.
  await page.locator('#frame_login, a:has-text("退出")').first()
    .waitFor({ state: "visible", timeout: timeoutMs });
  if (await logout.isVisible()) return { loggedIn: true, reusedSession: true };

  // Use frame locators rather than relying on iframe load timing or coordinates.
  const iframe = await page.locator("#frame_login").elementHandle({ timeout: timeoutMs });
  const form = await iframe.contentFrame();
  await iframe.dispose();
  if (!form) throw new Error("未找到东方财富登录表单，请检查页面是否加载完成。");
  await form.getByText("账号登录", { exact: true }).click({ timeout: timeoutMs });
  await form.getByRole("textbox", { name: "邮箱/手机", exact: true }).fill(account, { timeout: timeoutMs });
  await form.getByRole("textbox", { name: "请输入登录密码", exact: true }).fill(password, { timeout: timeoutMs });

  // This is an image toggle, not a native checkbox. Only click when unchecked.
  const agreement = visible(form, ".selectbox.unselected");
  if (await agreement.isVisible()) await agreement.click({ timeout: timeoutMs });
  const login = form.getByRole("button", { name: "登录", exact: true }).filter({ visible: true }).first();
  await login.click({ timeout: timeoutMs });
  status("已提交登录，等待验证结果。");

  const deadline = Date.now() + verificationTimeoutMs;
  let verificationStarted = false;
  let submittedAfterVerification = false;
  let submitting = false;
  let nextSessionCheck = Infinity;
  let probe;
  try {
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("登录窗口已关闭。");
      try {
        if (await logout.isVisible()) return { loggedIn: true, reusedSession: false };

        // A real Frame does not wait for an iframe that has already disappeared
        // during the successful redirect to the personal center.
        if (!form.isDetached()) {
          const success = await visibleText(form, "登录成功").isVisible();
          const pending = await form.getByRole("button", { name: "登录中", exact: true })
            .filter({ visible: true }).first().isVisible();
          if ((success || pending) && !submitting) {
            submitting = true;
            nextSessionCheck = Date.now() + Math.min(1500, timeoutMs / 2);
            status("网站正在登录，等待个人中心确认会话。");
          }

          const failure = form.getByText(
            /账号或密码错误|账户或密码错误|用户名或密码错误|密码错误|密码输入错误|账号不存在|账户不存在|账号已锁定|账户已锁定|登录失败/,
          ).filter({ visible: true });
          if (await failure.count()) {
            throw new Error("东方财富登录失败，请检查账号密码或账户状态。");
          }

          const verification = visibleText(form, "点击开始验证");
          if (!submitting && !verificationStarted && await verification.isVisible()) {
            verificationStarted = true;
            await verification.click({ timeout: Math.min(timeoutMs, Math.max(1, deadline - Date.now())) });
            status("已自动点击开始验证，验证通过后将自动完成登录。");
          }

          // The verification widget renders duplicate success labels. Filter
          // visible matches and take one; do not trigger strict-mode failures.
          if (!submitting && !submittedAfterVerification && await visibleText(form, "验证成功").isVisible()
            && await login.isVisible() && await login.isEnabled()) {
            submittedAfterVerification = true;
            await login.click({ timeout: Math.min(timeoutMs, Math.max(1, deadline - Date.now())) });
          }
        }

        // Let SSO callbacks finish first. A separate page verifies the shared
        // session without cancelling the original page's in-flight login.
        if (Date.now() >= nextSessionCheck) {
          probe ??= await page.context().newPage();
          const remaining = Math.max(1, deadline - Date.now());
          try {
            await probe.goto(EASTMONEY_LOGIN_URL, {
              waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, remaining),
            });
            await logoutLink(probe).waitFor({ state: "visible", timeout: Math.min(800, Math.max(1, deadline - Date.now())) });
            if (!await logout.isVisible()) {
              await page.goto(EASTMONEY_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
              await logout.waitFor({ state: "visible", timeout: timeoutMs });
            }
            return { loggedIn: true, reusedSession: false };
          } catch (error) {
            if (error?.name !== "TimeoutError" && !isNavigationChange(error)) throw error;
            nextSessionCheck = Date.now() + 1500;
          }
        }
      } catch (error) {
        if (!isNavigationChange(error)) throw error;
      }
      await page.waitForTimeout(250);
    }
  } finally {
    await probe?.close().catch(() => {});
  }
  throw new Error("自动登录超时：网站未自动通过验证或未确认登录成功。");
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  if (value == null) return fallback;
  if (!Number.isFinite(number) || number < 1) throw new Error("登录超时参数必须为正数。");
  return number;
}
