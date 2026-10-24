import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium " +
  "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2";

const variants: Record<Variant, string> = {
  primary: "bg-(--color-signal) text-white hover:bg-(--color-signal-strong)",
  secondary:
    "bg-(--color-paper-raised) text-(--color-ink) border border-(--color-line-strong) hover:border-(--color-signal)",
  danger: "bg-(--color-bad) text-white hover:brightness-95",
  ghost: "text-(--color-ink-muted) hover:text-(--color-ink) hover:bg-black/5",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
