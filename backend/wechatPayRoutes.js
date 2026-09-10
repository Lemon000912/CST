import crypto from "node:crypto";
import express from "express";
import { BillingError } from "./billing.js";
import {
  RECHARGE_PACKAGE,
  completeRechargeOrder,
  createRechargeOrder,
  getRechargeOrderByNo,
} from "./recharge.js";
import { PaymentProviderError, verifyWechatNotification } from "./rechargeProviders.js";

const PUBLIC_STATUS = Object.freeze({
  creating: "PENDING",
  pending: "PENDING",
  paid: "PAID",
  closed: "CLOSED",
  failed: "FAILED",
});

function statusOf(order) {
  return PUBLIC_STATUS[order?.status] || "FAILED";
}

function errorResponse(res, error, fallbackMessage) {
  if (error instanceof BillingError || error instanceof PaymentProviderError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error(`[WechatPay] ${fallbackMessage}:`, error?.message || error);
  return res.status(500).json({ error: fallbackMessage, code: "wechat-pay-internal-error" });
}

function publicApiOrder(order) {
  return {
    success: true,
    orderNo: order.orderNo,
    amount: order.amountFen,
    codeUrl: order.codeUrl || null,
    status: statusOf(order),
    paidAt: order.paidAt || null,
    expiresAt: order.expiresAt,
    // Preserve the richer shape for the existing recharge modal.
    order,
  };
}

export function createWechatPayRouter({
  requireAuthenticatedUser,
  rateLimit = () => true,
  createOrder = createRechargeOrder,
  getOrderByNo = getRechargeOrderByNo,
  verifyNotification = verifyWechatNotification,
  completeOrder = completeRechargeOrder,
} = {}) {
  if (typeof requireAuthenticatedUser !== "function") {
    throw new TypeError("requireAuthenticatedUser middleware is required");
  }
  const router = express.Router();

  router.post("/native", requireAuthenticatedUser, async (req, res) => {
    try {
      if (!rateLimit("wechat-pay:user", req.auth.userId)) {
        return res.status(429).set("Retry-After", "600").json({
          error: "微信支付下单过于频繁，请稍后再试",
          code: "rate-limit-exceeded",
        });
      }
      const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim() || crypto.randomUUID();
      const order = await createOrder({
        userId: req.auth.userId,
        provider: "wechat",
        planId: req.body?.planId,
        idempotencyKey,
      });
      return res.status(order.status === "paid" ? 200 : 201).json(publicApiOrder(order));
    } catch (error) {
      return errorResponse(res, error, "创建微信支付订单失败");
    }
  });

  router.get("/orders/:outTradeNo/status", requireAuthenticatedUser, async (req, res) => {
    try {
      const order = await getOrderByNo({ userId: req.auth.userId, orderNo: req.params.outTradeNo });
      return res.json(publicApiOrder(order));
    } catch (error) {
      return errorResponse(res, error, "查询微信支付订单失败");
    }
  });

  // No website JWT: the signature on the original body authenticates WeChat.
  router.post("/notify", async (req, res) => {
    try {
      const payment = verifyNotification({ headers: req.headers, rawBody: req.rawBody, body: req.body });
      console.log(`[WechatPay] callback verified ${payment.orderNo || "non-success"}`);
      if (payment.paid) await completeOrder({ provider: "wechat", ...payment });
      return res.status(200).json({ code: "SUCCESS", message: "成功" });
    } catch (error) {
      const code = error instanceof BillingError || error instanceof PaymentProviderError
        ? error.code
        : "wechat-pay-internal-error";
      console.error(`[WechatPay] callback rejected: ${code}`);
      const status = error instanceof BillingError || error instanceof PaymentProviderError
        ? error.status
        : 500;
      return res.status(status >= 500 ? 500 : 400).json({ code: "FAIL", message: "支付通知处理失败" });
    }
  });

  return router;
}

export { PUBLIC_STATUS, publicApiOrder, statusOf, RECHARGE_PACKAGE };
