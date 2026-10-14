import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const baseClasses =
  "inline-flex items-center justify-center gap-2 rounded-field font-medium " +
  "transition-colors disabled:cursor-not-allowed " +
  "disabled:opacity-60 select-none";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white hover:bg-brand-hover active:bg-brand-800 " +
    "shadow-card",
  secondary:
    "bg-surface text-ink border border-border-strong hover:bg-surface-muted",
  ghost: "bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "bg-danger text-white hover:brightness-95 active:brightness-90",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(baseClasses, variantClasses[variant], sizeClasses[size], className);
}

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
};

type ButtonAsButton = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };

type ButtonAsAnchor = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

/**
 * Foundational action control. Renders an anchor when `href` is provided and a
 * native button otherwise, so links stay semantic and server-renderable.
 */
export function Button(props: ButtonProps) {
  const { variant, size, className, children, ...rest } = props;
  const classes = buttonClasses(variant, size, className);

  if (typeof rest.href === "string") {
    const anchorProps = rest as Omit<ButtonAsAnchor, keyof CommonProps>;
    return (
      <a {...anchorProps} className={classes}>
        {children}
      </a>
    );
  }

  const buttonProps = rest as Omit<ButtonAsButton, keyof CommonProps>;
  return (
    <button {...buttonProps} className={classes}>
      {children}
    </button>
  );
}
