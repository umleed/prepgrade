/**
 * Shared, pure navigation model for every role workspace shell.
 *
 * WHY THIS EXISTS
 * The Institution, Teacher, and Student workspaces all render the same
 * responsive shell (see `components/shell/role-shell.tsx`). Keeping the item
 * shape and the active-state rule here — free of React and JSX — means the real
 * navigation contract stays unit-testable with `npm test` and every workspace
 * reads ONE definition instead of re-typing (and drifting) its own.
 *
 * This module is data + a pure predicate only. Icon markup lives in the shell's
 * registry (`components/shell/nav-icons.tsx`), keyed by `NavIconKey`.
 */

/** Keys the shell's icon registry maps to inline SVG markup. */
export type NavIconKey =
  | "dashboard"
  | "exams"
  | "question-bank"
  | "students"
  | "teachers"
  | "classes"
  | "subjects"
  | "analytics"
  | "results"
  | "performance"
  | "practice"
  | "settings"
  | "jamb"
  | "waec"
  | "neco";

/** How a pathname maps an item's route: only itself, or itself and children. */
export type NavMatch = "exact" | "prefix";

/** A single navigation row rendered by the shell. */
export type NavItem = {
  label: string;
  /** `null` marks a not-yet-built destination: rendered disabled, never linked. */
  href: string | null;
  icon: NavIconKey;
  /**
   * - "exact": only the route itself is active (the Dashboard link must not
   *   light up on every child page).
   * - "prefix": the route and everything under it (`/institution/students/123`).
   */
  match: NavMatch;
};

/** A titled (or untitled) group of nav items rendered as one `<nav>`. */
export type NavSectionConfig = {
  heading?: string;
  items: readonly NavItem[];
};

/**
 * Active-state rule shared by every rendered nav item. Disabled items
 * (`href: null`) are never active; a pathname only matches its own route or a
 * child of it — never a sibling that merely shares a string prefix.
 */
export function isNavItemActive(pathname: string, item: NavItem): boolean {
  if (item.href === null) return false;
  if (item.match === "exact") return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
