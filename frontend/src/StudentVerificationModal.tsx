import { useEffect, useRef, useState } from "react";
import { submitStudentVerification, type StudentVerification } from "./api";
import type { PointBalance } from "./types";

export function StudentVerificationModal({
  open,
  verification,
  onClose,
  onVerified,
}: {
  open: boolean;
  verification: StudentVerification;
  onClose: () => void;
  onVerified: (verification: StudentVerification, billing?: PointBalance) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setError(null);
    setSuccess(null);
  }, [open]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, open]);

  if (!open) return null;

  const verify = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await submitStudentVerification(file);
      onVerified(result.verification, result.billing);
      setSuccess(result.rewarded ? "认证成功，1000 积分已到账。" : "你的学生身份已经认证。奖励已发放过，不会重复入账。");
      setFile(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "学生证认证失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const school = verification.details?.school;
  return (
    <div
      className="fixed inset-0 z-[190] flex items-center justify-center bg-black/65 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="学生认证"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-[color:var(--t-br10)] bg-[var(--t-modal)] shadow-2xl shadow-black/35">
        <div className="flex items-start justify-between border-b border-[color:var(--t-br08)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--t-text-heading)]">学生认证</h2>
            <p className="mt-1 text-[11px] text-[var(--t-text-muted)]">认证成功一次性赠送 1000 积分</p>
          </div>
          <button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-2 py-1 text-lg text-[var(--t-text-close)] hover:text-[var(--t-text-close-hover)] disabled:opacity-40" aria-label="关闭学生认证窗口">×</button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {verification.verified ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-4 text-center">
              <div className="text-3xl text-emerald-500" aria-hidden>✓</div>
              <div className="mt-2 text-[15px] font-semibold text-emerald-500">学生身份已认证</div>
              {school ? <div className="mt-1 text-[12px] text-[var(--t-text-muted)]">{school}</div> : null}
              <div className="mt-1 text-[11px] text-[var(--t-text-caption)]">认证奖励仅发放一次</div>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="flex min-h-[190px] w-full flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-blue-500/40 bg-blue-500/5 px-4 py-4 text-center transition hover:border-blue-500/70 hover:bg-blue-500/10 disabled:opacity-50"
              >
                {previewUrl ? (
                  <img src={previewUrl} alt="待认证学生证预览" className="max-h-[220px] max-w-full rounded-lg object-contain" />
                ) : (
                  <>
                    <span className="text-3xl" aria-hidden>▣</span>
                    <span className="mt-3 text-[13px] font-medium text-[var(--t-text)]">上传学生证正面照片</span>
                    <span className="mt-1 text-[11px] leading-relaxed text-[var(--t-text-muted)]">支持 JPG、PNG、WEBP、GIF，图片需清晰显示学校名称及姓名或学号</span>
                  </>
                )}
              </button>
              <input
                ref={inputRef}
                type="file"
                className="hidden"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  event.target.value = "";
                  setError(null);
                  setSuccess(null);
                  if (next && next.size > 12 * 1024 * 1024) {
                    setFile(null);
                    setError("图片过大，单张学生证图片上限 12MB");
                    return;
                  }
                  setFile(next);
                }}
              />
              {file ? <div className="truncate text-center text-[11px] text-[var(--t-text-muted)]">{file.name} · {(file.size / 1024 / 1024).toFixed(1)}MB</div> : null}
              <button type="button" disabled={!file || busy} onClick={() => void verify()} className="qp-btn-primary w-full justify-center py-2.5 disabled:cursor-not-allowed disabled:opacity-45">
                {busy ? "模型 A 正在识别…" : "提交认证"}
              </button>
            </>
          )}

          {error ? <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-400">{error}</div> : null}
          {success ? <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] leading-relaxed text-emerald-500">{success}</div> : null}
          <p className="text-center text-[10px] leading-relaxed text-[var(--t-text-caption)]">图片仅用于本次模型识别，不保存原图。请遮挡不需要提交的敏感信息。</p>
        </div>
      </div>
    </div>
  );
}
