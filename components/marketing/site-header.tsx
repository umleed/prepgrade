import { Suspense } from "react";
import Link from "next/link";
import { Show, UserButton } from "@clerk/nextjs";
import { Button } from "@/components/ui";
import { ArrowRightIcon, LogoMark } from "./icons";
import { cn } from "@/lib/utils";

/** Primary navigation for public marketing pages. */
const navLinks = [
  { label: "Home", href: "/" },
  { label: "Features", href: "/#features" },
  { label: "For Schools", href: "/#for-schools" },
  { label: "For Teachers", href: "/#for-teachers" },
  { label: "For Students", href: "/#for-students" },
  { label: "Pricing", href: "/pricing" },
];

/** Native <details> disclosure — no client JavaScript required. */
const resourceLinks = [
  { label: "Why PrepGrade", href: "/#why-prepgrade" },
  { label: "How it works", href: "/#workflow" },
  { label: "Results & analytics", href: "/#features" },
];

export function SiteHeader({
  activeHref = "/",
}: {
  /** href of the nav item to mark as the current page (defaults to Home). */
  activeHref?: string;
} = {}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
      {/* Keyboard users can jump straight to the page content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-field focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-xl font-bold tracking-tight text-ink"
        >
          <LogoMark />
          PrepGrade
        </Link>

        {/* Compact disclosure menu on small screens — native <details>, no JS. */}
        <details className="relative ml-auto lg:hidden">
          <summary className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-field border border-border text-ink-muted hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
            <span className="sr-only">Open navigation menu</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              aria-hidden="true"
              className="h-5 w-5"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </summary>
          <nav
            aria-label="Mobile"
            className="absolute right-0 top-12 w-56 rounded-card border border-border bg-surface p-2 shadow-raised"
          >
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="block rounded-field px-3 py-2 text-sm font-medium text-ink-muted hover:bg-surface-muted hover:text-ink"
              >
                {link.label}
              </a>
            ))}
            {resourceLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="block rounded-field px-3 py-2 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink"
              >
                {link.label}
              </a>
            ))}
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
              <Suspense fallback={null}>
                <Show when="signed-out">
                  <Button href="/login" variant="secondary" size="sm">
                    Log in
                  </Button>
                  <Button href="/register" variant="primary" size="sm">
                    Get Started
                  </Button>
                </Show>
                <Show when="signed-in">
                  <Button href="/dashboard" variant="primary" size="sm">
                    Dashboard
                  </Button>
                  <div className="flex items-center gap-2 px-1 pt-1">
                    <UserButton />
                    <span className="text-sm text-ink-muted">Account</span>
                  </div>
                </Show>
              </Suspense>
            </div>
          </nav>
        </details>

        <nav
          aria-label="Main"
          className="mx-auto hidden items-center gap-1 lg:flex"
        >
          {navLinks.map((link) => {
            const isActive = link.href === activeHref;
            return (
              <a
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "rounded-field px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-muted hover:text-ink",
                  isActive
                    ? "text-ink underline decoration-brand decoration-2 underline-offset-8"
                    : "text-ink-muted",
                )}
              >
                {link.label}
              </a>
            );
          })}

          {/* Resources disclosure — native <details>, no JS. */}
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-field px-3 py-2 text-sm font-medium text-ink-muted hover:bg-surface-muted hover:text-ink [&::-webkit-details-marker]:hidden">
              Resources
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                aria-hidden="true"
                className="h-3.5 w-3.5"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </summary>
            <ul className="absolute left-0 top-11 w-52 rounded-card border border-border bg-surface p-2 shadow-raised">
              {resourceLinks.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="block rounded-field px-3 py-2 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        </nav>

        <div className="hidden items-center gap-2 lg:ml-auto lg:flex">
          <Suspense fallback={null}>
            <Show when="signed-out">
            <Button href="/login" variant="secondary" size="sm">
              Log in
            </Button>
            <Button href="/register" variant="primary" size="sm">
              Get Started
              <ArrowRightIcon className="hidden h-4 w-4 lg:inline" />
            </Button>
          </Show>
            <Show when="signed-in">
              <Button href="/dashboard" variant="secondary" size="sm">
                Dashboard
              </Button>
              <UserButton />
            </Show>
          </Suspense>
        </div>
      </div>
    </header>
  );
}
