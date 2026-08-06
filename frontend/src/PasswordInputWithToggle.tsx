import { useState, type ComponentPropsWithoutRef } from "react";

function EyeIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export type PasswordInputWithToggleProps = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  /** 外层容器 class（如 mt-1） */
  wrapperClassName?: string;
};

/**
 * 密码输入 + 右侧「显示/隐藏」切换，不引入图标依赖。
 */
export function PasswordInputWithToggle({
  wrapperClassName = "",
  className = "",
  ...rest
}: PasswordInputWithToggleProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={`relative ${wrapperClassName}`.trim()}>
      <input
        {...rest}
        type={visible ? "text" : "password"}
        className={`${className} pr-10`.trim()}
      />
      <button
        type="button"
        tabIndex={-1}
        className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded p-1 text-[var(--t-text-muted)] outline-none hover:bg-[color:var(--t-br-hover05)] hover:text-[var(--t-text)] focus-visible:ring-2 focus-visible:ring-[color:var(--t-accent-ring)]"
        aria-label={visible ? "隐藏密码" : "显示密码"}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}
