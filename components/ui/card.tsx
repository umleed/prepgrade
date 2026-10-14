import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type DivProps = HTMLAttributes<HTMLDivElement>;

/** White surface container with consistent border, radius, and shadow. */
export function Card({ className, ...rest }: DivProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-border bg-surface shadow-card",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: DivProps) {
  return (
    <div className={cn("flex flex-col gap-1 p-5", className)} {...rest} />
  );
}

export function CardTitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-base font-semibold text-ink", className)} {...rest}>
      {children}
    </h3>
  );
}

export function CardDescription({
  className,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-sm leading-6 text-ink-muted", className)} {...rest} />
  );
}

export function CardContent({ className, ...rest }: DivProps) {
  return <div className={cn("p-5 pt-0", className)} {...rest} />;
}

export function CardFooter({
  className,
  children,
  ...rest
}: DivProps & { children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-border p-5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
