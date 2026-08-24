const DEFAULT_SCENE = "CST_REGISTER";
const DEFAULT_CODE_TYPE = 6;
const DEFAULT_EXPIRE_SECONDS = 300;
const DEFAULT_TRY_COUNT = 5;

export class SmsVerificationError extends Error {
  constructor(message, { code = "sms-verification-error", status = 502, providerCode = "" } = {}) {
    super(message);
    this.name = "SmsVerificationError";
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
  }
}

function env(name, aliases = []) {
  for (const key of [name, ...aliases]) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function boundedInteger(raw, fallback, min, max) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function verificationCodeType(raw) {
  const value = Number(raw);
  return [4, 6, 8].includes(value) ? value : DEFAULT_CODE_TYPE;
}

export function getSmsVerificationConfig() {
  return {
    accessKeyId: env("VOLC_ACCESSKEY", ["VOLC_ACCESS_KEY_ID"]),
    secretAccessKey: env("VOLC_SECRETKEY", ["VOLC_SECRET_ACCESS_KEY"]),
    smsAccount: env("VOLC_SMS_ACCOUNT"),
    sign: env("VOLC_SMS_SIGN"),
    templateId: env("VOLC_SMS_TEMPLATE_ID"),
    scene: env("VOLC_SMS_SCENE") || DEFAULT_SCENE,
    userExtCode: env("VOLC_SMS_USER_EXT_CODE"),
    tag: env("VOLC_SMS_TAG"),
    codeType: verificationCodeType(process.env.VOLC_SMS_CODE_TYPE),
    expireSeconds: boundedInteger(
      process.env.VOLC_SMS_EXPIRE_SECONDS,
      DEFAULT_EXPIRE_SECONDS,
      180,
      1800,
    ),
    tryCount: boundedInteger(process.env.VOLC_SMS_TRY_COUNT, DEFAULT_TRY_COUNT, 1, 10),
  };
}

export function isSmsVerificationConfigured() {
  const config = getSmsVerificationConfig();
  return Boolean(
    config.accessKeyId
      && config.secretAccessKey
      && config.smsAccount
      && config.sign
      && config.templateId
      && config.scene,
  );
}

function requireSmsVerificationConfig() {
  const config = getSmsVerificationConfig();
  const missing = [];
  if (!config.accessKeyId) missing.push("VOLC_ACCESSKEY");
  if (!config.secretAccessKey) missing.push("VOLC_SECRETKEY");
  if (!config.smsAccount) missing.push("VOLC_SMS_ACCOUNT");
  if (!config.sign) missing.push("VOLC_SMS_SIGN");
  if (!config.templateId) missing.push("VOLC_SMS_TEMPLATE_ID");
  if (!config.scene) missing.push("VOLC_SMS_SCENE");
  if (missing.length) {
    throw new SmsVerificationError(`短信服务未配置：${missing.join(", ")}`, {
      code: "sms-not-configured",
      status: 503,
    });
  }
  return config;
}

async function createSmsService(config) {
  const module = await import("@volcengine/openapi");
  const sms = module.sms ?? module.default?.sms;
  const service = sms?.defaultService ?? (sms?.SmsService ? new sms.SmsService() : null);
  if (!service) {
    throw new SmsVerificationError("火山短信 SDK 未正确加载", {
      code: "sms-sdk-unavailable",
      status: 503,
    });
  }
  service.setAccessKeyId(config.accessKeyId);
  service.setSecretKey(config.secretAccessKey);
  return service;
}

function providerFailure(response) {
  const metadata = response?.ResponseMetadata;
  const error = metadata?.Error ?? metadata;
  const code = String(error?.Code ?? "").trim();
  const codeN = Number(error?.CodeN ?? 0);
  if (!code && (!Number.isFinite(codeN) || codeN === 0)) return null;
  return {
    code: code || String(codeN),
    message: String(error?.Message ?? "火山短信服务请求失败").trim(),
  };
}

function normalizeProviderException(error) {
  if (error instanceof SmsVerificationError) return error;
  const response = error?.response?.data;
  const provider = providerFailure(response);
  return new SmsVerificationError("短信服务暂时不可用，请稍后重试", {
    code: "sms-provider-failed",
    status: 502,
    providerCode: provider?.code ?? String(error?.code ?? ""),
  });
}

export async function sendRegisterVerificationCode(phone, options = {}) {
  const config = requireSmsVerificationConfig();
  const service = options.service ?? await createSmsService(config);
  try {
    const response = await service.SendVerifyCode({
      SmsAccount: config.smsAccount,
      Sign: config.sign,
      TemplateID: config.templateId,
      PhoneNumber: String(phone),
      Scene: config.scene,
      UserExtCode: config.userExtCode,
      Tag: config.tag,
      CodeType: config.codeType,
      ExpireTime: config.expireSeconds,
      TryCount: config.tryCount,
    });
    const failure = providerFailure(response);
    if (failure) {
      throw new SmsVerificationError("验证码发送失败，请检查手机号或稍后重试", {
        code: "sms-send-failed",
        status: 502,
        providerCode: failure.code,
      });
    }
    const messageIds = response?.Result?.MessageID;
    if (!Array.isArray(messageIds) || !messageIds.length) {
      throw new SmsVerificationError("短信服务未返回消息编号", {
        code: "sms-send-invalid-response",
        status: 502,
      });
    }
    return { expiresIn: config.expireSeconds };
  } catch (error) {
    throw normalizeProviderException(error);
  }
}

export async function checkRegisterVerificationCode(phone, code, options = {}) {
  const normalizedCode = String(code ?? "").trim();
  if (!/^\d{4,8}$/.test(normalizedCode)) {
    throw new SmsVerificationError("请输入正确的短信验证码", {
      code: "sms-code-invalid-format",
      status: 400,
    });
  }
  const config = requireSmsVerificationConfig();
  const service = options.service ?? await createSmsService(config);
  try {
    const response = await service.CheckVerifyCode({
      SmsAccount: config.smsAccount,
      PhoneNumber: String(phone),
      Scene: config.scene,
      Code: normalizedCode,
    });
    const failure = providerFailure(response);
    if (failure) {
      throw new SmsVerificationError("验证码校验服务暂时不可用", {
        code: "sms-check-failed",
        status: 502,
        providerCode: failure.code,
      });
    }
    const result = String(response?.Result ?? "").trim();
    if (result === "0") return true;
    if (result === "1") {
      throw new SmsVerificationError("短信验证码错误", {
        code: "sms-code-incorrect",
        status: 400,
      });
    }
    if (result === "2") {
      throw new SmsVerificationError("短信验证码已过期，请重新获取", {
        code: "sms-code-expired",
        status: 400,
      });
    }
    throw new SmsVerificationError("短信验证码校验结果无效", {
      code: "sms-check-invalid-response",
      status: 502,
    });
  } catch (error) {
    throw normalizeProviderException(error);
  }
}
