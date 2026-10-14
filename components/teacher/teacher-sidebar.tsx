"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Navigation items for the teaching workspace sidebar. Items whose route
 * hasn't been built yet use `href: null` so they render as disabled
 * placeholders rather than linking to a 404.
 */
type NavItem = {
  label: string;
  href: string | null;
  icon: React.ReactNode;
};

const mainNav: NavItem[] = [
  {
    // Teacher dashboard ships in prompt 26.
    label: "Dashboard",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
      </svg>
    ),
  },
  {
    // Exam list and details (prompt 17). Institution admins land here too —
    // the institution sidebar's "Exams" links to this shared workspace.
    label: "My Exams",
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
    // The teacher view of classes ships with the teacher dashboard (prompt 26);
    // admin class management lives under /institution/classes.
    label: "Classes",
    href: null,
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
    label: "Students",
    href: null,
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
    // Results and analytics ship in prompts 25, 27–29.
    label: "Results & Analytics",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M3 3v18h18" />
        <path d="m7 14 3.5-3.5 3 2.5L19 7" />
      </svg>
    ),
  },
];

function NavSection({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <nav aria-label="Main navigation">
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          // Section links stay active on their child routes (/…/questions/123).
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

export function TeacherSidebar({
  institutionName,
  roleLabel,
}: {
  institutionName: string;
  roleLabel: string;
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
        <p className="text-2xs text-ink-muted">{roleLabel}</p>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto px-3">
        <NavSection items={mainNav} pathname={pathname} />
      </div>

      <div className="border-t border-border px-4 py-3">
        <Link
          href="/dashboard"
          className="text-xs text-ink-muted hover:text-ink hover:underline"
        >
          Back to my overview
        </Link>
      </div>
    </aside>
  );
}
