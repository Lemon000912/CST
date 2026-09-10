import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  createRechargeOrder,
  fetchRechargeCatalog,
  fetchRechargeOrder,
} from "./api";
import type {
  PointBalance,
  RechargeCatalog,
  RechargeOrder,
  RechargeProvider,
} from "./types";

function formatPoints(value: number | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "—";
}

let cachedRechargeCatalog: RechargeCatalog | null = null;
let rechargeCatalogRequest: Promise<RechargeCatalog> | null = null;

function loadRechargeCatalog(refresh = false): Promise<RechargeCatalog> {
  if (!refresh && cachedRechargeCatalog) return Promise.resolve(cachedRechargeCatalog);
  if (rechargeCatalogRequest) return rechargeCatalogRequest;
  rechargeCatalogRequest = fetchRechargeCatalog()
    .then((next) => {
      cachedRechargeCatalog = next;
      return next;
    })
    .finally(() => {
      rechargeCatalogRequest = null;
    });
  return rechargeCatalogRequest;
}

export function preloadRechargeCatalog(): Promise<RechargeCatalog> {
  return loadRechargeCatalog();
}

export default function SchoolRechargeModal({
  open,
  balance,
  onClose,
  onPaid,
}: {
  open: boolean;
  balance: PointBalance | null;
  onClose: () => void;
  onPaid: (billing?: PointBalance) => void;
}) {
  const [catalog, setCatalog] = useState<RechargeCatalog | null>(() => cachedRechargeCatalog);
  const [provider, setProvider] = useState<RechargeProvider>("wechat");
  const [order, setOrder] = useState<RechargeOrder | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paidHandledRef = useRef(false);
  const pollingStartedAtRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cached = cachedRechargeCatalog;
    paidHandledRef.current = false;
    pollingStartedAtRef.current = 0;
    setOrder(null);
    setError(null);
    setCreatingOrder(false);
    setCatalog(cached);
    setCatalogLoading(!cached);
    void loadRechargeCatalog(Boolean(cached))
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
        // 支付宝入口暂时下线；恢复时移除 id 过滤，并补回下方的支付宝占位项。
        const firstEnabled = next.providers.find((item) => item.id === "wechat" && item.enabled);
        if (firstEnabled) setProvider(firstEnabled.id);
      })
      .catch((reason) => {
        if (!cancelled && !cached) {
          setError(reason instanceof Error ? reason.message : "充值配置加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !order?.codeUrl || order.qrCodeDataUrl) return;
    let cancelled = false;
    void QRCode.toDataURL(order.codeUrl, { errorCorrectionLevel: "M", margin: 1, width: 280 })
      .then((qrCodeDataUrl) => {
        if (cancelled) return;
        setOrder((current) => current?.id === order.id ? { ...current, qrCodeDataUrl } : current);
      })
      .catch(() => {
        if (!cancelled) setError("付款二维码生成失败，请重新发起支付");
      });
    return () => {
      cancelled = true;
    };
  }, [open, order?.codeUrl, order?.id, order?.qrCodeDataUrl]);

  useEffect(() => {
    if (!open || !order || (order.status !== "creating" && order.status !== "pending")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await fetchRechargeOrder(order);
        if (cancelled) return;
        setError(null);
        setOrder((current) => ({ ...next, qrCodeDataUrl: current?.qrCodeDataUrl ?? next.qrCodeDataUrl }));
        if (next.status === "paid") {
          if (!paidHandledRef.current) {
            paidHandledRef.current = true;
            onPaid(next.billing);
          }
          return;
        }
        if (next.status === "failed" || next.status === "closed") {
          setError("订单未完成，请重新创建扫码订单");
          return;
        }
        const pollingDeadline = Math.min(next.expiresAt, pollingStartedAtRef.current + 5 * 60 * 1000);
        if (Date.now() >= pollingDeadline) {
          setError("二维码已过期，请重新创建订单");
          return;
        }
        timer = setTimeout(poll, 2_000);
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "支付状态查询失败");
        timer = setTimeout(poll, 4_000);
      }
    };
    if (!pollingStartedAtRef.current) pollingStartedAtRef.current = Date.now();
    timer = setTimeout(poll, 1_500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, onPaid, order?.id, order?.status]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;
  const activeCatalog = catalog ?? cachedRechargeCatalog;
  // 学生版充值弹窗当前只展示微信支付，后端返回的支付宝通道暂不暴露给用户。
  const visibleProviders = activeCatalog?.providers.filter((item) => item.id === "wechat") ?? [];
  const enabledProviders = visibleProviders.filter((item) => item.enabled);
  const providerLabel = activeCatalog?.providers.find((item) => item.id === order?.provider)?.label ?? "支付应用";

  const startPayment = async () => {
    setCreatingOrder(true);
    setError(null);
    paidHandledRef.current = false;
    pollingStartedAtRef.current = Date.now();
    try {
      setOrder(await createRechargeOrder(provider, activeCatalog?.package.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建充值订单失败");
    } finally {
      setCreatingOrder(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/65 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="积分充值"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] shadow-2xl shadow-black/35">
        <div className="flex items-start justify-between border-b border-[color:var(--t-br08)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--t-text-heading)]">积分充值</h2>
            <p className="mt-1 text-[11px] text-[var(--t-text-muted)]">
              当前余额 {formatPoints(balance?.balance)} 积分
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-lg text-[var(--t-text-close)] hover:text-[var(--t-text-close-hover)]" aria-label="关闭充值窗口">
            ×
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-xl border border-[color:var(--t-br10)] bg-[var(--t-muted)] px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-[var(--t-text-muted)]">充值套餐</span>
              <span className="text-[18px] font-semibold text-[var(--t-text-heading)]">
                ¥{activeCatalog?.package.amountYuan ?? 100}
              </span>
            </div>
            <div className="mt-1 text-right text-[13px] font-medium text-[var(--t-text)]">
              获得 {(activeCatalog?.package.points ?? 1000).toLocaleString()} 积分
            </div>
          </div>

          {!order ? (
            <>
              <div>
                <div className="mb-2 text-[12px] font-medium text-[var(--t-text)]">选择扫码方式</div>
                <div className="grid grid-cols-1 gap-2">
                  {(activeCatalog ? visibleProviders : [
                    // { id: "alipay" as const, label: "支付宝", enabled: false },
                    { id: "wechat" as const, label: "微信支付", enabled: false },
                  ]).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!item.enabled || catalogLoading || creatingOrder}
                      onClick={() => setProvider(item.id)}
                      className={`rounded-xl border px-3 py-3 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        provider === item.id
                          ? "border-blue-500 bg-blue-500/10 text-blue-500"
                          : "border-[color:var(--t-br08)] bg-[var(--t-field)] text-[var(--t-text-muted)] hover:border-[color:var(--t-br12)]"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                disabled={catalogLoading || creatingOrder || enabledProviders.length === 0}
                onClick={() => void startPayment()}
                className="qp-btn-primary w-full justify-center py-2.5 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {creatingOrder ? "正在创建订单…" : "生成付款二维码"}
              </button>
              {!catalogLoading && !creatingOrder && activeCatalog && enabledProviders.length === 0 ? (
                <p className="text-center text-[11px] leading-relaxed text-amber-500">支付通道尚未配置，请联系管理员。</p>
              ) : null}
            </>
          ) : order.status === "paid" ? (
            <div className="py-4 text-center">
              <div className="text-4xl" aria-hidden>✓</div>
              <div className="mt-3 text-[16px] font-semibold text-emerald-500">充值成功</div>
              <div className="mt-1 text-[12px] text-[var(--t-text-muted)]">已到账 {order.points.toLocaleString()} 积分</div>
              <button type="button" onClick={onClose} className="qp-btn-primary mt-5 w-full justify-center py-2.5">完成</button>
            </div>
          ) : order.status === "failed" || order.status === "closed" ? (
            <div className="py-4 text-center">
              <div className="text-[16px] font-semibold text-amber-500">
                {order.status === "closed" ? "订单已关闭" : "支付失败"}
              </div>
              <div className="mt-2 text-[12px] text-[var(--t-text-muted)]">
                {order.status === "closed" ? "二维码已过期，请重新发起支付" : "本次订单未完成，未发放积分"}
              </div>
              <button
                type="button"
                disabled={creatingOrder}
                onClick={() => void startPayment()}
                className="qp-btn-primary mt-5 w-full justify-center py-2.5 disabled:opacity-45"
              >
                {creatingOrder ? "正在创建订单…" : "重新支付"}
              </button>
            </div>
          ) : (
            <div className="text-center">
              {order.qrCodeDataUrl ? (
                <img src={order.qrCodeDataUrl} alt={`${providerLabel}付款二维码`} className="mx-auto h-[240px] w-[240px] rounded-xl bg-white p-2" />
              ) : (
                <div className="mx-auto flex h-[240px] w-[240px] items-center justify-center rounded-xl bg-white/5 text-[12px] text-[var(--t-text-muted)]">二维码生成中…</div>
              )}
              <div className="mt-3 text-[13px] font-medium text-[var(--t-text)]">请使用{providerLabel}扫码支付 ¥{order.amountYuan}</div>
              <div className="mt-1 text-[11px] font-medium text-amber-500">等待扫码</div>
              <div className="mt-1 text-[11px] text-[var(--t-text-muted)]">支付完成后页面会自动更新，请勿重复付款</div>
              {order.codeUrl ? (
                <button type="button" onClick={() => window.location.assign(order.codeUrl!)} className="qp-link-accent mt-3 text-[11px] underline underline-offset-2 sm:hidden">在手机中打开{providerLabel}</button>
              ) : null}
            </div>
          )}

          {error ? <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-400">{error}</div> : null}
          <p className="text-center text-[10px] leading-relaxed text-[var(--t-text-caption)]">支付结果以微信支付的服务端通知为准</p>
        </div>
      </div>
    </div>
  );
}
