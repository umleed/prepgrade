import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Inline stroke icons for the marketing pages. Dependency-free (no icon
 * library) and decorative by default — every icon is `aria-hidden` so screen
 * readers rely on the adjacent text.
 */
type IconProps = {
  className?: string;
  children: ReactNode;
};

function Icon({ className, children }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      {children}
    </svg>
  );
}

/** PrepGrade brand mark — two-tone open book (navy + brand blue). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("h-9 w-9", className)}
    >
      <path
        d="M12 5.8C10.3 4.4 8.1 3.9 5.6 4.2c-1.3.2-2.3 1.3-2.3 2.6v9.3c0 1.5 1.4 2.6 2.9 2.3 2-.4 3.9.1 5.8 1.4V5.8Z"
        fill="currentColor"
        className="text-ink"
      />
      <path
        d="M12 5.8c1.7-1.4 3.9-1.9 6.4-1.6 1.3.2 2.3 1.3 2.3 2.6v9.3c0 1.5-1.4 2.6-2.9 2.3-2-.4-3.9.1-5.8 1.4V5.8Z"
        fill="currentColor"
        className="text-brand"
      />
    </svg>
  );
}

export function QuestionBankIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M9 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M9 4a2 2 0 0 0-2 2v12" />
      <path d="M11 9h5M11 13h5" />
    </Icon>
  );
}

export function ExamBuilderIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h5" />
      <path d="m14.5 16.5 1.5 1.5 3-3.5" />
    </Icon>
  );
}

export function CbtDeliveryIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
      <path d="m9.5 8.5 4 2.5-4 2.5v-5Z" />
    </Icon>
  );
}

export function AutoGradingIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 5-5.5" />
    </Icon>
  );
}

export function ResultsIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 20V10M10 20V4M16 20v-8M21 20H3" />
    </Icon>
  );
}

export function AnalyticsIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 3v18h18" />
      <path d="m7 14 3.5-3.5 3 2.5L19 7" />
    </Icon>
  );
}

export function SchoolIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 21h18" />
      <path d="M5 21V8l7-4 7 4v13" />
      <path d="M10 21v-5h4v5" />
      <path d="M9 11h.01M15 11h.01" />
    </Icon>
  );
}

export function TeacherIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="7" r="3.5" />
      <path d="M5 21c0-3.87 3.13-7 7-7s7 3.13 7 7" />
    </Icon>
  );
}

export function StudentIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="7" r="3.5" />
      <path d="M5.5 20c.6-3.2 3.2-5.5 6.5-5.5s5.9 2.3 6.5 5.5" />
      <path d="M17 4.5 20 6l-3 1.5" />
    </Icon>
  );
}

export function BoltIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />
    </Icon>
  );
}

export function UsersIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5" />
      <circle cx="16.5" cy="9" r="2.6" />
      <path d="M15.8 14.4c2.4.3 4.2 2.2 4.7 4.6" />
    </Icon>
  );
}

export function DevicesIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect x="2.5" y="5" width="13" height="9.5" rx="1.5" />
      <path d="M6 18.5h6" />
      <rect x="17" y="9" width="4.5" height="9.5" rx="1.2" />
    </Icon>
  );
}

/** Filled star for rating rows (not stroke-based, so drawn directly). */
export function StarIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4-5.7-3.2-5.7 3.2 1.2-6.4L2.8 9.5l6.4-.8L12 2.8Z" />
    </svg>
  );
}

export function PlayIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8.5 5.5 3.5L10 15.5v-7Z" />
    </Icon>
  );
}

export function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 12h16M14 6l6 6-6 6" />
    </Icon>
  );
}

export function ShieldIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 3 5 6v5c0 4.4 2.9 8.4 7 9.5 4.1-1.1 7-5.1 7-9.5V6l-7-3Z" />
      <path d="m9 12 2 2 4-4.5" />
    </Icon>
  );
}

/** Plain check mark — used for feature lists and pricing tiers. */
export function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m5 13 4 4L19 7" />
    </Icon>
  );
}

export function DocEditIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
      <path d="M14 3v4h4" />
      <path d="M9 9h3M9 13h2" />
      <path d="m14.7 18.3 4.6-4.6 1.7 1.7-4.6 4.6h-1.7v-1.7Z" />
    </Icon>
  );
}
