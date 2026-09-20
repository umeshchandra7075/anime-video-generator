import { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

const variants: Record<string, string> = {
  primary: "bg-lantern-500 text-ink-950 hover:bg-lantern-400",
  secondary: "border border-ink-600 text-paper/80 hover:border-moon-400 hover:text-paper",
  ghost: "text-paper/70 hover:text-paper",
  danger: "border border-red-500/50 text-red-300 hover:bg-red-500/10",
};

export function Button({ variant = "primary", className = "", disabled, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled}
      className={`rounded-full px-5 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    />
  );
}
