"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui";
import {
  isNavItemActive,
  type NavItem,
  type NavSectionConfig,
} from "@/lib/navigation/nav-items";
import { BrandMark, NavIcon } from "./nav-icons";

/**
 * Responsive role workspace shell — the single navigation frame shared by the
 * Institution, Teacher, and Student workspaces.
 *
 * Behaviour (identical for every role):
 * - Desktop (lg+): a persistent sidebar, expanded by default, with a collapse
 *   control to an icon rail. Collapsed labels stay accessible via the CSS
 *   Tooltip (hover AND keyboard focus) plus the link's own accessible name.
 *   The collapse preference persists in localStorage, read through
 *   `useSyncExternalStore` so server and client markup never disagree.
 * - Tablet/mobile (<lg): a compact top bar with a menu button; navigation opens
 *   as a modal drawer built on the native <dialog> — the browser supplies the
 *   focus trap, inert background, Escape dismissal, and focus return; the
 *   backdrop click and post-navigation close are handled here.
 *
 * The shell is role-agnostic: it renders whatever `sections` it is given,
 * resolves icons from the shared registry, and derives the footer from small,
 * optional props. Navigation destinations and the active-state rule live in the
 * pure `lib/navigation/*` modules and are covered by `npm test`; nothing here
 * decides access — identity arrives as props resolved server-side by the layout.
 */

/* --- Navigation rows -------------------------------------------------------- */

function NavItemRow({
  item,
  pathname,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const isActive = isNavItemActive(pathname, item);
  const isDisabled = item.href === null;

  const classes = cn(
    "flex w-full items-center gap-3 rounded-field px-3 py-2 text-sm font-medium transition-colors",
    collapsed && "justify-center px-2",
    isActive
      ? "bg-brand-50 text-brand-700"
      : "text-ink-muted hover:bg-surface-muted hover:text-ink",
    isDisabled && "opacity-50 cursor-not-allowed",
  );

  // Collapsed keeps the label in the accessibility tree (sr-only) and shows it
  // visually through the Tooltip, which also appears on keyboard focus.
  const content = (
    <>
      <NavIcon icon={item.icon} />
      <span className={cn("min-w-0 truncate", collapsed && "sr-only")}>
        {item.label}
      </span>
    </>
  );

  // Branch the JSX on `item.href === null` itself so TypeScript narrows the
  // Link destination; `isDisabled` only feeds the class list.
  const row =
    item.href === null ? (
      <span className={classes} aria-disabled="true" title={item.label}>
        {content}
      </span>
    ) : (
      <Link
        href={item.href}
        className={classes}
        aria-current={isActive ? "page" : undefined}
        aria-label={collapsed ? item.label : undefined}
        onClick={onNavigate}
      >
        {content}
      </Link>
    );

  return (
    <li>
      {collapsed && item.href !== null ? (
        <Tooltip content={item.label} side="right" className="w-full">
          {row}
        </Tooltip>
      ) : (
        row
      )}
    </li>
  );
}

function NavSection({
  heading,
  items,
  pathname,
  collapsed,
  onNavigate,
}: {
  heading?: string;
  items: readonly NavItem[];
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={heading || "Main navigation"}>
      {heading ? (
        <p
          className={cn(
            "px-3 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-subtle",
            collapsed && "sr-only",
          )}
        >
          {heading}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <NavItemRow
            key={item.label}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </nav>
  );
}

/** Renders each section, separating them with the same rhythm as before. */
function NavSections({
  sections,
  pathname,
  collapsed,
  onNavigate,
}: {
  sections: readonly NavSectionConfig[];
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      {sections.map((section, index) => (
        <div key={section.heading ?? `section-${index}`} className={index > 0 ? "mt-6" : undefined}>
          <NavSection
            heading={section.heading}
            items={section.items}
            pathname={pathname}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </div>
      ))}
    </>
  );
}

/* --- Brand + tenant context ------------------------------------------------- */

function Brand({ brandName, collapsed }: { brandName: string; collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-5",
        collapsed && "justify-center px-2",
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-field bg-brand text-white">
        <BrandMark />
      </div>
      <span
        className={cn(
          "min-w-0 truncate text-base font-bold tracking-tight text-ink",
          collapsed && "sr-only",
        )}
      >
        {brandName}
      </span>
    </div>
  );
}

function ContextCard({
  institutionName,
  roleLabel,
  collapsed,
}: {
  institutionName: string;
  roleLabel: string;
  collapsed: boolean;
}) {
  if (collapsed) {
    // One recognizable mark instead of the name; the full name stays one
    // click (expand) or one hover (the rail's tooltips) away.
    return (
      <div className="mx-2 mb-4 flex justify-center">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-field border border-border bg-surface-muted text-ink-muted"
          title={institutionName}
          aria-hidden="true"
        >
          <BrandMark />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-3 mb-4 rounded-card border border-border bg-surface-muted px-3 py-2.5">
      <p className="truncate text-sm font-semibold text-ink" title={institutionName}>
        {institutionName}
      </p>
      <p className="text-2xs text-ink-muted">{roleLabel}</p>
    </div>
  );
}

/* --- Collapse control + footer ---------------------------------------------- */

/** Desktop-only control; the drawer gets its own close button instead. */
function CollapseButton({
  collapsed,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onToggleCollapse?: () => void;
}) {
  if (!onToggleCollapse) return null;
  return (
    <button
      type="button"
      onClick={onToggleCollapse}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-field",
        "text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink",
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-4 w-4"
      >
        {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
      </svg>
    </button>
  );
}

function ShellFooter({
  collapsed,
  user,
  footerLink,
  footerSlot,
  onNavigate,
  onToggleCollapse,
}: {
  collapsed: boolean;
  user?: { name: string };
  footerLink?: { label: string; href: string };
  footerSlot?: ReactNode;
  /** Closes the drawer when a footer link is tapped (mobile only). */
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
}) {
  // Collapsed rail: nothing but the expand control, centered.
  if (collapsed) {
    return (
      <div className="flex justify-center border-t border-border px-2 py-3">
        <CollapseButton collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
      </div>
    );
  }

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex items-center gap-2">
        {user ? (
          <>
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-2xs font-semibold uppercase text-brand-700"
            >
              {user.name.slice(0, 1)}
            </span>
            <p className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={user.name}>
              {user.name}
            </p>
          </>
        ) : footerLink ? (
          <Link
            href={footerLink.href}
            onClick={onNavigate}
            className="min-w-0 flex-1 text-xs text-ink-muted hover:text-ink hover:underline"
          >
            {footerLink.label}
          </Link>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {onToggleCollapse ? (
          <CollapseButton collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
        ) : null}
      </div>
      {footerSlot ? <div className="mt-1.5">{footerSlot}</div> : null}
    </div>
  );
}

/* --- Desktop panel ---------------------------------------------------------- */

function NavPanel({
  pathname,
  collapsed,
  brandName,
  institutionName,
  roleLabel,
  sections,
  user,
  footerLink,
  footerSlot,
  onToggleCollapse,
}: {
  pathname: string;
  collapsed: boolean;
  brandName: string;
  institutionName: string;
  roleLabel: string;
  sections: readonly NavSectionConfig[];
  user?: { name: string };
  footerLink?: { label: string; href: string };
  footerSlot?: ReactNode;
  onToggleCollapse: () => void;
}) {
  return (
    <>
      <Brand brandName={brandName} collapsed={collapsed} />

      <ContextCard
        institutionName={institutionName}
        roleLabel={roleLabel}
        collapsed={collapsed}
      />

      {/* Collapsed rail: no scroll clipping, or the right-hand tooltips vanish. */}
      <div
        className={cn(
          "flex-1 px-3",
          collapsed ? "overflow-visible" : "overflow-y-auto",
        )}
      >
        <NavSections sections={sections} pathname={pathname} collapsed={collapsed} />
      </div>

      <ShellFooter
        collapsed={collapsed}
        user={user}
        footerLink={footerLink}
        footerSlot={footerSlot}
        onToggleCollapse={onToggleCollapse}
      />
    </>
  );
}

/* --- Modal navigation drawer (tablet + mobile) ------------------------------ */

function NavDrawer({
  open,
  onClose,
  pathname,
  brandName,
  institutionName,
  roleLabel,
  sections,
  navAriaLabel,
  user,
  footerLink,
  footerSlot,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
  brandName: string;
  institutionName: string;
  roleLabel: string;
  sections: readonly NavSectionConfig[];
  navAriaLabel: string;
  user?: { name: string };
  footerLink?: { label: string; href: string };
  footerSlot?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Sync the imperative dialog API with the controlled `open` prop (same
  // pattern as components/ui/dialog.tsx: native modal = focus trap + inert
  // background + Escape + focus return, no dependencies).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      closeButtonRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={navAriaLabel}
      onClose={onClose}
      onClick={(event) => {
        // Clicks on the scrim land on the <dialog> element itself.
        if (event.target === dialogRef.current) onClose();
      }}
      className={cn(
        "fixed inset-0 m-0 h-full w-full max-w-none bg-transparent p-0",
        // A closed <dialog modal> is hidden by the UA; keep both states explicit.
        !open && "hidden",
      )}
    >
      <div className="flex h-full w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-raised">
        <div className="flex items-center justify-between gap-2 border-b border-border px-2">
          <Brand brandName={brandName} collapsed={false} />
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-field",
              "text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink",
            )}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4">
              <path
                d="m4 4 8 8m0-8-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="pt-1">
            <ContextCard
              institutionName={institutionName}
              roleLabel={roleLabel}
              collapsed={false}
            />
          </div>
          <div className="flex-1 px-3">
            <NavSections
              sections={sections}
              pathname={pathname}
              collapsed={false}
              onNavigate={onClose}
            />
          </div>
          <ShellFooter
            collapsed={false}
            user={user}
            footerLink={footerLink}
            footerSlot={footerSlot}
            onNavigate={onClose}
          />
        </div>
      </div>
    </dialog>
  );
}

/* --- Collapse preference (localStorage-backed, SSR-safe) -------------------- */

/**
 * Desktop collapse preference lives in localStorage — an external system, so
 * it is read through `useSyncExternalStore` rather than an after-mount effect:
 * server rendering reports "expanded", the client picks up the stored value
 * without a hydration mismatch, and cross-tab changes re-sync live.
 */
function subscribeCollapsed(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function useCollapsePreference(storageKey: string): [boolean, () => void] {
  const getSnapshot = useCallback(() => {
    try {
      return window.localStorage.getItem(storageKey) === "true";
    } catch {
      // Storage blocked (private mode): behave as expanded.
      return false;
    }
  }, [storageKey]);

  const stored = useSyncExternalStore(subscribeCollapsed, getSnapshot, () => false);
  // Fallback when writes are blocked, so the toggle still works this session.
  const [override, setOverride] = useState<boolean | null>(null);
  const toggle = () => {
    const next = !(override ?? stored);
    try {
      window.localStorage.setItem(storageKey, String(next));
      setOverride(null);
    } catch {
      setOverride(next);
    }
  };
  return [override ?? stored, toggle];
}

/* --- Public shell ----------------------------------------------------------- */

export type RoleShellProps = {
  /** Real institution/tenant name resolved server-side from trusted records. */
  institutionName: string;
  /** Role caption shown under the tenant name (e.g. "Institution admin"). */
  roleLabel: string;
  /** One or more titled nav groups; the shared contract from `lib/navigation`. */
  sections: readonly NavSectionConfig[];
  /** localStorage key remembering the desktop collapse state for this role. */
  collapseStorageKey: string;
  /** Accessible name for the navigation region and drawer. */
  navAriaLabel: string;
  /** Product wordmark in the brand header. Defaults to "PrepGrade". */
  brandName?: string;
  /** Signed-in user identity, rendered as the footer avatar + name. */
  user?: { name: string };
  /** A single footer link (e.g. "Back to my overview"), when there is no user. */
  footerLink?: { label: string; href: string };
  /** Custom footer content rendered under the identity (e.g. sign-out). */
  footerSlot?: ReactNode;
  children: ReactNode;
};

export function RoleShell({
  institutionName,
  roleLabel,
  sections,
  collapseStorageKey,
  navAriaLabel,
  brandName = "PrepGrade",
  user,
  footerLink,
  footerSlot,
  children,
}: RoleShellProps) {
  const pathname = usePathname();
  const [collapsed, toggleCollapsed] = useCollapsePreference(collapseStorageKey);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Every destination inside the drawer carries onNavigate -> onClose, so a
  // tap on any nav item dismisses the drawer as part of the navigation.

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* Desktop: persistent, collapsible rail. */}
      <aside
        aria-label={navAriaLabel}
        className={cn(
          "hidden h-full shrink-0 flex-col border-r border-border bg-surface lg:flex",
          "transition-[width] duration-200 ease-in-out",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <NavPanel
          pathname={pathname}
          collapsed={collapsed}
          brandName={brandName}
          institutionName={institutionName}
          roleLabel={roleLabel}
          sections={sections}
          user={user}
          footerLink={footerLink}
          footerSlot={footerSlot}
          onToggleCollapse={toggleCollapsed}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Tablet/mobile: compact header with the drawer trigger. */}
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            aria-controls="role-nav-drawer"
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-field",
              "text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink",
            )}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              aria-hidden="true"
              className="h-5 w-5"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-field bg-brand text-white">
            <BrandMark className="h-3.5 w-3.5" />
          </div>
          <p className="min-w-0 truncate text-sm font-semibold text-ink" title={institutionName}>
            {institutionName}
          </p>
        </header>

        {/* Pages keep their own header/main; the region scrolls beneath. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>

      <div id="role-nav-drawer">
        <NavDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          pathname={pathname}
          brandName={brandName}
          institutionName={institutionName}
          roleLabel={roleLabel}
          sections={sections}
          navAriaLabel={navAriaLabel}
          user={user}
          footerLink={footerLink}
          footerSlot={footerSlot}
        />
      </div>
    </div>
  );
}
