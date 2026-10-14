"use client";

import { useEffect, useRef } from "react";
import { useClerk } from "@clerk/nextjs";
import { SIGN_OUT_REDIRECT_URL } from "@/lib/auth/access";
import { LogoutIcon, BuildingIcon, SearchIcon, BellIcon } from "./icons";
import { Dropdown, DropdownItem } from "@/components/ui";

/*
 * Shared top bar for the platform (super-admin) shell — the white header
 * from the design reference: tenant-scope chip, global search, notification
 * placeholder, and the signed-in profile menu.
 *
 * Every control here is either real or honestly marked as unavailable:
 * - Search submits a GET to the institution directory, reusing the existing
 *   server-side name search (⌘K / Ctrl+K focuses the field).
 * - The bell is a disabled placeholder — notifications ship in a later
 *   phase, so it carries no unread badge and explains itself via title.
 * - The scope chip is static: an institution switcher doesn't exist yet.
 * - Sign out goes through Clerk's headless `useClerk().signOut`, same
 *   redirect target the previous per-page SignOutButton used.
 */

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "SA";
}

export function PlatformHeader({ userName }: { userName: string }) {
  const { signOut } = useClerk();
  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K focuses the directory search (the field's only shortcut).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4 lg:px-6">
      {/* Tenant-scope chip — static label, not a switcher (none exists yet). */}
      <div className="flex min-w-0 items-center gap-2.5 rounded-field border border-border bg-accent-purple-soft/60 py-1.5 pl-1.5 pr-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-purple-soft text-accent-purple">
          <BuildingIcon className="h-4 w-4" />
        </span>
        <span className="truncate text-sm font-medium text-ink">
          All Institutions
        </span>
      </div>

      <div className="flex items-center gap-2 lg:gap-4">
        {/* Global search → institution directory name search (real route). */}
        <form
          method="get"
          action="/platform/institutions"
          role="search"
          className="relative hidden md:block"
        >
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle">
            <SearchIcon className="h-4 w-4" />
          </span>
          <input
            ref={searchRef}
            type="search"
            name="q"
            placeholder="Search institutions..."
            aria-label="Search institutions by name"
            className="h-9 w-64 rounded-full border border-border bg-surface-muted pl-9 pr-12 text-sm text-ink placeholder:text-ink-subtle transition-colors hover:border-border-strong focus-visible:border-brand-300 xl:w-80"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-surface px-1.5 py-0.5 text-2xs font-medium text-ink-subtle xl:flex">
            ⌘K
          </kbd>
        </form>

        {/* Notifications — planned (prompt 35); no dot, no dead affordance. */}
        <button
          type="button"
          disabled
          aria-label="Notifications (not yet available)"
          title="Notifications are not yet available — planned for a later phase"
          className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted"
        >
          <BellIcon className="h-5 w-5" />
        </button>

        {/* Profile menu — the shell's sign-out entry point. */}
        <Dropdown
          variant="ghost"
          size="sm"
          align="end"
          triggerClassName="h-10 gap-2.5 px-1.5"
          className="shrink-0"
          label={
            <span className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
                {initialsOf(userName)}
              </span>
              <span className="hidden flex-col items-start leading-tight sm:flex">
                <span className="text-sm font-semibold text-ink">Super Admin</span>
                <span className="text-2xs text-ink-muted">Platform Administrator</span>
              </span>
            </span>
          }
        >
          <DropdownItem
            icon={<LogoutIcon className="h-4 w-4" />}
            onClick={() => void signOut({ redirectUrl: SIGN_OUT_REDIRECT_URL })}
          >
            Sign out
          </DropdownItem>
        </Dropdown>
      </div>
    </header>
  );
}
