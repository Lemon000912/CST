export type WxLoginOptions = {
  self_redirect: boolean;
  id: string;
  appid: string;
  scope: string;
  redirect_uri: string;
  state: string;
  style: string;
  href: string;
};

/**
 * Convert the backend authorization URL into the options expected by WeChat's
 * wxLogin.js. URLSearchParams decodes redirect_uri while wxLogin.js appends the
 * supplied value verbatim, so the callback must be encoded again here.
 */
export function buildWxLoginOptions(authorizationUrl: string, containerId: string): WxLoginOptions {
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
