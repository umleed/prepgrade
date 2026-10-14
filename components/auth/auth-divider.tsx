import { cn } from "@/lib/utils";

/** Horizontal "Or continue with" separator used between form and social auth. */
export function AuthDivider({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn("flex items-center gap-3 text-sm text-ink-subtle", className)}
      role="separator"
      aria-label={label}
    >
      <span className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
