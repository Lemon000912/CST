import { buildWxLoginOptions as buildWxLoginOptionsRuntime } from "./wechatLoginOptionsRuntime.js";

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
  return buildWxLoginOptionsRuntime(authorizationUrl, containerId);
}
