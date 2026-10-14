"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { SIGN_OUT_REDIRECT_URL } from "@/lib/auth/access";
import { cn } from "@/lib/utils";

/**
 * Navigation items for the student workspace sidebar. Items whose route
 * hasn't been built yet use `href: null` so they render as disabled
 * placeholders rather than linking to a 404 — the same convention the
 * teacher sidebar follows.
 */
type NavItem = {
  label: string;
  href: string | null;
  icon: React.ReactNode;
};

const mainNav: NavItem[] = [
  {
    // The student dashboard (prompt 20).
    label: "Dashboard",
    href: "/student",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
      </svg>
    ),
  },
  {
    // My Exams + pre-exam instructions (prompt 21) — the assigned-exam list
    // and the rules/start gate behind each row.
    label: "My Exams",
    href: "/student/exams",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M8 9h8M8 13h5" />
        <path d="m14.5 16.5 1.5 1.5 3-3.5" />
      </svg>
    ),
  },
  {
    // Results arrive with the grading engine (prompts 23–25).
    label: "My Results",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <path d="M3 3v18h18" />
        <path d="m7 14 3.5-3.5 3 2.5L19 7" />
      </svg>
    ),
  },
  {
    // Practice tests are a later phase (prompt 30).
    label: "Practice Tests",
    href: null,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4.5" />
        <circle cx="12" cy="12" r="1" />
      </svg>
    ),
  },
];

function NavSection({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <nav aria-label="Main navigation">
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          // Section links stay active on their child routes (/student/…).
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

export function StudentSidebar({
  institutionName,
  roleLabel,
  studentName,
}: {
  institutionName: string;
  roleLabel: string;
  studentName: string;
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

      {/* User footer — students have no shared overview to fall back to
          (/dashboard routes them straight back here), so the footer carries
          identity and sign-out instead. */}
      <div className="border-t border-border px-4 py-3">
        <p className="text-xs font-medium text-ink truncate">{studentName}</p>
        <SignOutButton redirectUrl={SIGN_OUT_REDIRECT_URL}>
          <button
            type="button"
            className="mt-1 text-xs text-ink-muted hover:text-ink hover:underline"
          >
            Sign out
          </button>
        </SignOutButton>
      </div>
    </aside>
  );
}
