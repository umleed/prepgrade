"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Navigation items for the institution sidebar. Items whose route hasn't been
 * built yet use `href: null` so they render as disabled placeholders rather
 * than linking to a 404.
 */
type NavItem = {
  label: string;
  href: string | null;
  icon: React.ReactNode;
};

const mainNav: NavItem[] = [
  {
    label: "Dashboard",
    href: "/institution",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
      </svg>
    ),
  },
  {
    // Exams (prompt 17) live in the teaching workspace, which institution
    // admins also hold (ROLE_AREAS.teacher) — same pattern as Question Bank.
    label: "Exams",
    href: "/teacher/exams",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M8 9h8M8 13h5" />
        <path d="m14.5 16.5 1.5 1.5 3-3.5" />
      </svg>
    ),
  },
  {
    // The question bank (prompt 15) lives in the teaching workspace, which
    // institution admins also hold (ROLE_AREAS.teacher).
    label: "Question Bank",
    href: "/teacher/questions",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M9 4h8a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
        <path d="M9 4a2 2 0 00-2 2v12" />
        <path d="M11 9h5M11 13h5" />
      </svg>
    ),
  },
  {
    label: "Students",
    href: "/institution/students",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5" />
        <circle cx="16.5" cy="9" r="2.6" />
        <path d="M15.8 14.4c2.4.3 4.2 2.2 4.7 4.6" />
      </svg>
    ),
  },
  {
    label: "Teachers",
    href: "/institution/teachers",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <circle cx="12" cy="7" r="3.5" />
        <path d="M5 21c0-3.87 3.13-7 7-7s7 3.13 7 7" />
      </svg>
    ),
  },
  {
    label: "Classes",
    href: "/institution/classes",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M3 21h18" />
        <path d="M5 21V8l7-4 7 4v13" />
        <path d="M10 21v-5h4v5" />
        <path d="M9 11h.01M15 11h.01" />
      </svg>
    ),
  },
  {
    label: "Subjects",
    href: "/institution/subjects",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
        <path d="M9 7h7M9 11h5" />
      </svg>
    ),
  },
  {
    label: "Results & Analytics",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M3 3v18h18" />
        <path d="m7 14 3.5-3.5 3 2.5L19 7" />
      </svg>
    ),
  },
  {
    label: "Settings",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.82 2 2 0 01-2.82 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.82 0 2 2 0 010-2.82l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.82-2.82l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.82 2.82l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
];

const examPrepNav: NavItem[] = [
  {
    label: "JAMB",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
  },
  {
    label: "WAEC",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12 2.5 2.5 5-5.5" />
      </svg>
    ),
  },
  {
    label: "NECO",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h3.5" />
        <path d="M14 3v4h4" />
        <path d="M9 9h3M9 13h2" />
      </svg>
    ),
  },
];

function NavSection({
  heading,
  items,
  pathname,
}: {
  heading?: string;
  items: NavItem[];
  pathname: string;
}) {
  return (
    <nav aria-label={heading || "Main navigation"}>
      {heading ? (
        <p className="px-3 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-subtle">
          {heading}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          // Section links stay active on their child routes (/…/teachers/123).
          const isActive =
            item.href !== null &&
            (pathname === item.href || pathname.startsWith(`${item.href}/`));
          const isDisabled = item.href === null;

          const content = (
            <>
              {item.icon}
              <span>{item.label}</span>
            </>
          );

          const classes = cn(
            "flex items-center gap-3 rounded-field px-3 py-2 text-sm font-medium transition-colors",
            isActive
              ? "bg-brand-50 text-brand-700"
              : "text-ink-muted hover:bg-surface-muted hover:text-ink",
            isDisabled && "opacity-50 cursor-not-allowed",
          );

          return (
            <li key={item.label}>
              {isDisabled ? (
                <span className={classes} aria-disabled="true">
                  {content}
                </span>
              ) : (
                <Link href={item.href!} className={classes} aria-current={isActive ? "page" : undefined}>
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function InstitutionSidebar({
  institutionName,
  userName,
}: {
  institutionName: string;
  userName: string;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface">
      {/* Brand header */}
      <div className="flex items-center gap-2 px-4 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-field bg-brand text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
            <path d="M3 21h18" />
            <path d="M5 21V8l7-4 7 4v13" />
          </svg>
        </div>
        <span className="text-base font-bold tracking-tight text-ink">
          PrepGrade
        </span>
      </div>

      {/* Institution context */}
      <div className="mx-3 mb-4 rounded-card border border-border bg-surface-muted px-3 py-2.5">
        <p className="text-sm font-semibold text-ink truncate">{institutionName}</p>
        <p className="text-2xs text-ink-muted">Institution Administrator</p>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto px-3">
        <NavSection items={mainNav} pathname={pathname} />

        <div className="mt-6">
          <NavSection heading="Exam Preparation" items={examPrepNav} pathname={pathname} />
        </div>
      </div>

      {/* User footer */}
      <div className="border-t border-border px-4 py-3">
        <p className="text-xs text-ink-muted truncate">{userName}</p>
      </div>
    </aside>
  );
}
