/*
 * Quiet "not wired up yet" panel body for platform dashboard cards whose
 * design exists but whose data source does not (revenue, subscriptions,
 * system health, time-series usage). Keeps the approved layout without
 * inventing a single figure — the note says exactly what is missing and
 * when it will exist.
 */
export function PanelNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-field border border-dashed border-border-strong bg-surface-muted/60 px-4 py-8 text-center">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-6 w-6 text-ink-subtle"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <p className="max-w-sm text-xs leading-5 text-ink-muted">{children}</p>
    </div>
  );
}
