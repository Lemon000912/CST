/**
 * Convert the backend authorization URL into the options expected by WeChat's
 * wxLogin.js. URLSearchParams decodes redirect_uri while wxLogin.js appends the
 * supplied value verbatim, so the callback must be encoded again here.
 *
 * Kept as plain JavaScript so the production server's Node 18 test runner can
 * execute the same implementation used by the TypeScript frontend.
 */
export function buildWxLoginOptions(authorizationUrl, containerId) {
  const url = new URL(authorizationUrl);
  const appid = url.searchParams.get("appid") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state") || "";

  if (!appid || !redirectUri || !state) {
    throw new Error("Incomplete WeChat authorization URL");
  }

  return {
    self_redirect: false,
    id: containerId,
    appid,
    scope: url.searchParams.get("scope") || "snsapi_login",
    redirect_uri: encodeURIComponent(redirectUri),
    state,
    style: "black",
    href: "",
  };
}
