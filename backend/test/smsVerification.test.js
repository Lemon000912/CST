import test from "node:test";
import assert from "node:assert/strict";
import {
  SmsVerificationError,
  checkRegisterVerificationCode,
  getSmsVerificationConfig,
  isSmsVerificationConfigured,
  sendRegisterVerificationCode,
} from "../smsVerification.js";

const ENV_KEYS = [
  "APP_EDITION",
  "VOLC_ACCESSKEY",
  "VOLC_SECRETKEY",
  "VOLC_SMS_ACCOUNT",
  "VOLC_SMS_SIGN",
  "VOLC_SMS_TEMPLATE_ID",
  "VOLC_SMS_SCENE",
  "VOLC_SMS_CODE_TYPE",
  "VOLC_SMS_EXPIRE_SECONDS",
  "VOLC_SMS_TRY_COUNT",
];

function configuredEnv(t) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    APP_EDITION: "school",
    VOLC_ACCESSKEY: "ak-test",
    VOLC_SECRETKEY: "sk-test",
    VOLC_SMS_ACCOUNT: "account-test",
    VOLC_SMS_SIGN: "sign-test",
    VOLC_SMS_TEMPLATE_ID: "ST_test",
    VOLC_SMS_SCENE: "CST_REGISTER",
    VOLC_SMS_CODE_TYPE: "6",
    VOLC_SMS_EXPIRE_SECONDS: "300",
    VOLC_SMS_TRY_COUNT: "5",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("SMS verification configuration is explicit and bounded", (t) => {
  configuredEnv(t);
  assert.equal(isSmsVerificationConfigured(), true);
  assert.deepEqual(
    {
      ...getSmsVerificationConfig(),
      accessKeyId: "redacted",
      secretAccessKey: "redacted",
    },
    {
      accessKeyId: "redacted",
      secretAccessKey: "redacted",
      smsAccount: "account-test",
      sign: "sign-test",
      templateId: "ST_test",
      scene: "CST_REGISTER",
      userExtCode: "",
      tag: "",
      codeType: 6,
      expireSeconds: 300,
      tryCount: 5,
    },
  );
});
test("sending a register code uses the provider verification API", async (t) => {
  configuredEnv(t);
  let payload;
  const service = {
    async SendVerifyCode(value) {
      payload = value;
      return { ResponseMetadata: {}, Result: { MessageID: ["message-1"] } };
    },
  };
  const result = await sendRegisterVerificationCode("13800138000", { service });
  assert.equal(result.expiresIn, 300);
  assert.equal(payload.PhoneNumber, "13800138000");
  assert.equal(payload.Scene, "CST_REGISTER_school_register");
  assert.equal(payload.CodeType, 6);
});

test("checking a register code distinguishes success, error, and expiry", async (t) => {
  configuredEnv(t);
  const success = { CheckVerifyCode: async () => ({ ResponseMetadata: {}, Result: "0" }) };
  assert.equal(await checkRegisterVerificationCode("13800138000", "123456", { service: success }), true);

  const incorrect = { CheckVerifyCode: async () => ({ ResponseMetadata: {}, Result: "1" }) };
  await assert.rejects(
    checkRegisterVerificationCode("13800138000", "123456", { service: incorrect }),
    (error) => error instanceof SmsVerificationError && error.code === "sms-code-incorrect",
  );

  const expired = { CheckVerifyCode: async () => ({ ResponseMetadata: {}, Result: "2" }) };
  await assert.rejects(
    checkRegisterVerificationCode("13800138000", "123456", { service: expired }),
    (error) => error instanceof SmsVerificationError && error.code === "sms-code-expired",
  );
});

test("verification codes cannot be reused across editions or purposes", async (t) => {
  configuredEnv(t);
  const issued = new Set();
  const service = {
    async SendVerifyCode(payload) {
      issued.add(`${payload.PhoneNumber}:${payload.Scene}`);
      return { Result: { MessageID: ["test-message"] } };
    },
    async CheckVerifyCode(payload) {
      return { Result: issued.has(`${payload.PhoneNumber}:${payload.Scene}`) ? "0" : "1" };
    },
  };
  await sendRegisterVerificationCode("13800138000", { service });
  for (const edition of ["enterprise", "finance"]) {
    process.env.APP_EDITION = edition;
    await assert.rejects(checkRegisterVerificationCode("13800138000", "123456", { service }), e => e.code === "sms-code-incorrect");
  }
  process.env.APP_EDITION = "school";
  for (const purpose of ["password-reset", "wechat-bind"]) {
    await assert.rejects(checkRegisterVerificationCode("13800138000", "123456", { service, purpose }), e => e.code === "sms-code-incorrect");
    await sendRegisterVerificationCode("13800138000", { service, purpose });
    assert.equal(await checkRegisterVerificationCode("13800138000", "123456", { service, purpose }), true);
  }
  assert.equal(await checkRegisterVerificationCode("13800138000", "123456", { service }), true);
});
