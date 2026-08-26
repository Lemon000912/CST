import { useEffect, useState } from "react";

const RHINO_FRAMES = Array.from({ length: 9 }, (_, index) => `/rhino/rhino-${index + 1}.jpg`);

/** 犀牛序列帧：挂载时循环播放，组件卸载时自然停止。 */
export function RhinoAnimation({
  className = "h-16 w-20",
  animate = true,
}: {
  className?: string;
  animate?: boolean;
}) {
  const [frame, setFrame] = useState(animate ? 0 : 4);

  useEffect(() => {
    if (!animate) {
      setFrame(4);
      return;
    }
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % RHINO_FRAMES.length);
    }, 180);
    return () => window.clearInterval(timer);
  }, [animate]);

  return (
    <img
      src={RHINO_FRAMES[frame]}
      alt="正在处理"
      className={`shrink-0 rounded-md object-contain ${className}`}
      draggable={false}
    />
  );
}

/** 统一加载指示（三点跳动 + 文案），替代各处零散 spinner /「检索文献」类提示 */
export function LoadingIndicator({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  return (
    <div className={`qp-loading-card ${className}`} role="status" aria-live="polite" aria-busy="true">
      <div className="flex items-center gap-3 text-sm text-[var(--t-text-secondary)]">
        <LoadingSpinner className="h-4 w-4 shrink-0 border-[var(--t-accent)] border-t-transparent" />
        <span className="leading-snug">{label}</span>
      </div>
    </div>
  );
}

/** 输入区附件按钮内的小 spinner */
export function LoadingSpinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-[var(--t-text-code)] border-t-transparent ${className}`}
      role="status"
      aria-label="加载中"
    />
  );
}
