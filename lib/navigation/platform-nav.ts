/**
 * Platform (super-admin) navigation configuration — pure, dependency-free, and
 * unit-testable (no React, no JSX icons), exactly like
 * `lib/navigation/institution-nav.ts`.
 *
 * WHY THIS EXISTS
 * The platform sidebar used to hardcode its destinations next to their SVG
 * markup, so a routing or active-state bug could not be covered by `npm test`
 * without pulling React into the runner. Keeping the destinations and the
 * active-state rules here means the real navigation contract is the thing under
 * test, and the client component only renders this data.
 *
 * SINGLE-OWNERSHIP CONTRACT
 * Every enabled destination is claimed by exactly ONE sidebar entry.
 * `/platform/usage` — the platform-wide usage & activity analytics surface — is
 * owned by the top-level "Analytics" item. It used to ALSO appear as an
 * Institutions submenu child ("Usage & Activity"): two entries with the same
 * href both resolve as active on that route, which duplicated navigation
 * ownership and left the canonical location for platform analytics ambiguous.
 * The submenu entry is gone rather than merely visually suppressed.
 *
 * HONESTY CONTRACT (prompt 31, AGENTS.md §8)
 * `href: null` still means "planned, not built": the row renders disabled with
 * a truthful "Not yet available" tooltip and never links anywhere. No disabled
 * item was promoted here, and no destination was invented.
 */

/** Keys the sidebar component maps to inline SVG markup. */
export type PlatformNavIconKey =
  | "dashboard"
  | "institutions"
  | "users"
  | "assessments"
  | "question-bank"
  | "analytics"
  | "billing"
  | "moderation"
  | "system-health"
  | "settings"
  | "plans"
  | "payment-history"
  | "audit-logs"
  | "announcements"
  | "help";

/** How a pathname maps an entry's route: only itself, or itself and children. */
export type PlatformNavMatch = "exact" | "prefix";

/** A submenu row shown when its parent group is expanded. */
export type PlatformNavChild = {
  label: string;
  /** `null` marks a not-yet-built destination: rendered disabled, never linked. */
  href: string | null;
};

export type PlatformNavItem = {
  label: string;
  /** `null` marks a not-yet-built destination: rendered disabled, never linked. */
  href: string | null;
  icon: PlatformNavIconKey;
  /**
   * - "exact": only the route itself is active (the Dashboard link must not
   *   light up on every `/platform/...` child page).
   * - "prefix": the route and everything under it (`/platform/institutions/abc`).
   */
  match: PlatformNavMatch;
  /** Optional sub-routes shown when the parent section is expanded. */
  children?: PlatformNavChild[];
};

/** The navigation group whose submenu opens on load for a given route. */
export const PLATFORM_INSTITUTIONS_GROUP = "Institutions";

/**
 * Platform usage & activity analytics — the single canonical destination of the
 * Analytics sidebar entry. Exported so the nav config, the page, and the tests
 * all reference ONE route string instead of drifting literals.
 */
export const PLATFORM_USAGE_PATH = "/platform/usage";

/** The Institutions directory — the parent route of the institution group. */
export const PLATFORM_INSTITUTIONS_PATH = "/platform/institutions";

/** The three cross-tenant operational directories that ship with this work.
 *  Each owns exactly one top-level nav entry (single-ownership contract). */
export const PLATFORM_USERS_PATH = "/platform/users";
export const PLATFORM_ASSESSMENTS_PATH = "/platform/assessments";
export const PLATFORM_QUESTION_BANK_PATH = "/platform/question-bank";

/** The two read-only oversight surfaces that ship with this work. Each owns
 *  exactly one top-level nav entry. Settings is configuration/health posture
 *  (reuses the health probes); Moderation is question-state visibility plus
 *  the audit trail (reuses the question reader + audit reader). Neither adds
 *  a write path. */
export const PLATFORM_SETTINGS_PATH = "/platform/settings";
export const PLATFORM_MODERATION_PATH = "/platform/moderation";

export const PLATFORM_MAIN_NAV: readonly PlatformNavItem[] = [
  { label: "Dashboard", href: "/platform", icon: "dashboard", match: "exact" },
  {
    label: PLATFORM_INSTITUTIONS_GROUP,
    href: PLATFORM_INSTITUTIONS_PATH,
    icon: "institutions",
    match: "prefix",
    children: [
      { label: "All Institutions", href: PLATFORM_INSTITUTIONS_PATH },
      { label: "Add Institution", href: "/platform/institutions/new" },
      { label: "Pending Approvals", href: "/platform/institutions/pending-approvals" },
      // Subscription Plans keeps its home in this group; Usage & Activity does
      // not, because /platform/usage belongs to Analytics (see the contract).
      { label: "Subscription Plans", href: "/platform/subscription-plans" },
    ],
  },
  { label: "Users", href: PLATFORM_USERS_PATH, icon: "users", match: "prefix" },
  {
    label: "Assessments",
    href: PLATFORM_ASSESSMENTS_PATH,
    icon: "assessments",
    match: "prefix",
  },
  {
    label: "Question Bank",
    href: PLATFORM_QUESTION_BANK_PATH,
    icon: "question-bank",
    match: "prefix",
  },
  // The canonical platform analytics surface (prompt 31's Usage & Activity
  // page) — reached once, from here, with no duplicate submenu entry.
  { label: "Analytics", href: PLATFORM_USAGE_PATH, icon: "analytics", match: "prefix" },
  { label: "Billing & Subscriptions", href: null, icon: "billing", match: "prefix" },
  {
    label: "Moderation",
    href: PLATFORM_MODERATION_PATH,
    icon: "moderation",
    match: "prefix",
  },
  // Operational views ship with prompt 33: live health checks plus the
  // read-only append-only audit log.
  { label: "System Health", href: "/platform/health", icon: "system-health", match: "prefix" },
  {
    label: "Settings",
    href: PLATFORM_SETTINGS_PATH,
    icon: "settings",
    match: "prefix",
  },
];

export const PLATFORM_PLATFORM_NAV: readonly PlatformNavItem[] = [
  { label: "Plans & Features", href: null, icon: "plans", match: "prefix" },
  { label: "Payment History", href: null, icon: "payment-history", match: "prefix" },
  { label: "Audit Logs", href: "/platform/audit", icon: "audit-logs", match: "prefix" },
  { label: "Announcements", href: null, icon: "announcements", match: "prefix" },
  { label: "Help & Support", href: null, icon: "help", match: "prefix" },
];

/**
 * Active-state rule shared by every rendered top-level nav item. Disabled items
 * (`href: null`) are never active; a pathname only matches its own route or a
 * child of it — never a sibling that merely shares a string prefix.
 */
export function isPlatformNavItemActive(
  pathname: string,
  item: Pick<PlatformNavItem, "href" | "match">,
): boolean {
  if (item.href === null) return false;
  if (item.match === "exact") return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Active-state rule for one submenu child. Most specific match wins: on
 * `/platform/institutions/new` only "Add Institution" lights up, not also
 * "All Institutions". Disabled children are never active.
 */
export function isPlatformNavChildActive(
  pathname: string,
  siblings: readonly PlatformNavChild[],
  child: PlatformNavChild,
): boolean {
  if (!isPlatformNavItemActive(pathname, { href: child.href, match: "prefix" })) {
    return false;
  }
  return !siblings.some(
    (sibling) =>
      sibling.href !== child.href &&
      (sibling.href?.length ?? 0) > (child.href?.length ?? 0) &&
      isPlatformNavItemActive(pathname, { href: sibling.href, match: "prefix" }),
  );
}

/**
 * Which group (by label) starts expanded on first render. Only routes that
 * actually live in the group's submenu qualify — `/platform/usage` no longer
 * belongs to Institutions now that Analytics owns it, so it must not open an
 * unrelated submenu on load.
 */
export function defaultExpandedGroupLabel(pathname: string): string | null {
  const institutions = PLATFORM_MAIN_NAV.find(
    (item) => item.label === PLATFORM_INSTITUTIONS_GROUP,
  );
  if (!institutions?.children) return null;
  const claimed =
    pathname.startsWith(`${PLATFORM_INSTITUTIONS_PATH}/`) ||
    institutions.children.some((child) => child.href === pathname);
  return claimed ? PLATFORM_INSTITUTIONS_GROUP : null;
}

/** Look up a top-level item by label — used by tests and the shell's wiring. */
export function findPlatformNavItem(
  label: string,
): PlatformNavItem | undefined {
  return (
    PLATFORM_MAIN_NAV.find((item) => item.label === label) ??
    PLATFORM_PLATFORM_NAV.find((item) => item.label === label)
  );
}
