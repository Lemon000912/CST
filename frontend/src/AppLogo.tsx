import { APP_NAME } from "./branding";

type Size = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-10 w-10",
  md: "h-12 w-12",
  lg: "h-16 w-16",
  xl: "h-20 w-20",
};

export function AppLogo({ size = "sm", className = "" }: { size?: Size; className?: string }) {
  return (
    <img
      src="/logo.png"
      alt={APP_NAME}
      draggable={false}
      className={`object-contain ${SIZE_CLASS[size]} ${className}`.trim()}
    />
  );
}
