/**
 * Student workspace navigation configuration — pure, dependency-free, and
 * unit-testable (no React, no JSX icons), mirroring `institution-nav.ts`.
 *
 * The destinations and the active-state rule are the contract; the responsive
 * shell (`components/shell/role-shell.tsx`) only renders this data. Items whose
 * route has not been built yet use `href: null` so they render as disabled
 * placeholders rather than linking to a 404.
 */

import type { NavItem } from "./nav-items.ts";

export const STUDENT_MAIN_NAV: readonly NavItem[] = [
  { label: "Dashboard", href: "/student", icon: "dashboard", match: "exact" },
  { label: "My Exams", href: "/student/exams", icon: "exams", match: "prefix" },
  { label: "My Results", href: "/student/results", icon: "results", match: "prefix" },
  {
    label: "My Performance",
    href: "/student/performance",
    icon: "performance",
    match: "prefix",
  },
  { label: "Practice Tests", href: null, icon: "practice", match: "prefix" },
];

/** Look up an item by label — used by tests and by the shell's aria wiring. */
export function findStudentNavItem(label: string): NavItem | undefined {
  return STUDENT_MAIN_NAV.find((item) => item.label === label);
}
