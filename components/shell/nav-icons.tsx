import type { ReactNode } from "react";
import type { NavIconKey } from "@/lib/navigation/nav-items";

/**
 * Icon markup for the shared role shell, keyed by `NavIconKey`.
 *
 * The pure nav configs (`lib/navigation/*-nav.ts`) stay JSX-free by referencing
 * an icon KEY; the shell resolves that key to inline SVG here. One registry
 * serves every workspace, so Institution, Teacher, and Student icons stay
 * visually consistent and a new destination only needs a key, not new markup.
 */
const NAV_ICONS: Record<NavIconKey, ReactNode> = {
  dashboard: (
    <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
  ),
  exams: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h5" />
      <path d="m14.5 16.5 1.5 1.5 3-3.5" />
    </>
  ),
  "question-bank": (
    <>
      <path d="M9 4h8a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
      <path d="M9 4a2 2 0 00-2 2v12" />
      <path d="M11 9h5M11 13h5" />
    </>
  ),
  students: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5" />
      <circle cx="16.5" cy="9" r="2.6" />
      <path d="M15.8 14.4c2.4.3 4.2 2.2 4.7 4.6" />
    </>
  ),
  teachers: (
    <>
      <circle cx="12" cy="7" r="3.5" />
      <path d="M5 21c0-3.87 3.13-7 7-7s7 3.13 7 7" />
    </>
  ),
  classes: (
    <>
      <path d="M3 21h18" />
      <path d="M5 21V8l7-4 7 4v13" />
      <path d="M10 21v-5h4v5" />
      <path d="M9 11h.01M15 11h.01" />
    </>
  ),
  subjects: (
    <>
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      <path d="M9 7h7M9 11h5" />
    </>
  ),
  analytics: (
    <>
      <path d="M3 3v18h18" />
      <path d="m7 14 3.5-3.5 3 2.5L19 7" />
    </>
  ),
  results: (
    <>
      <path d="M3 3v18h18" />
      <path d="m7 14 3.5-3.5 3 2.5L19 7" />
    </>
  ),
  performance: (
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  ),
  practice: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  settings: (
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.82 2 2 0 01-2.82 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.82 0 2 2 0 010-2.82l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.82-2.82l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.82 2.82l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  ),
  jamb: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  waec: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 5-5.5" />
    </>
  ),
  neco: (
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h3.5" />
      <path d="M14 3v4h4" />
      <path d="M9 9h3M9 13h2" />
    </>
  ),
};

export function NavIcon({ icon }: { icon: NavIconKey }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={icon === "settings" ? 1.5 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5 shrink-0"
    >
      {NAV_ICONS[icon]}
    </svg>
  );
}

/** The PrepGrade roofline mark shown in the brand header and mobile top bar. */
export function BrandMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 21h18" />
      <path d="M5 21V8l7-4 7 4v13" />
    </svg>
  );
}
