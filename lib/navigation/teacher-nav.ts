/**
 * Teacher workspace navigation configuration — pure, dependency-free, and
 * unit-testable (no React, no JSX icons), mirroring `institution-nav.ts`.
 *
 * The destinations and the active-state rule are the contract; the responsive
 * shell (`components/shell/role-shell.tsx`) only renders this data. Items whose
 * route has not been built yet use `href: null` so they render as disabled
 * placeholders rather than linking to a 404.
 */

import type { NavItem } from "./nav-items.ts";

export const TEACHER_MAIN_NAV: readonly NavItem[] = [
  { label: "Dashboard", href: "/teacher", icon: "dashboard", match: "exact" },
  { label: "My Exams", href: "/teacher/exams", icon: "exams", match: "prefix" },
  {
    label: "Question Bank",
    href: "/teacher/questions",
    icon: "question-bank",
    match: "prefix",
  },
  { label: "Classes", href: null, icon: "classes", match: "prefix" },
  { label: "Students", href: null, icon: "students", match: "prefix" },
  { label: "Results & Analytics", href: null, icon: "analytics", match: "prefix" },
];

/** Look up an item by label — used by tests and by the shell's aria wiring. */
export function findTeacherNavItem(label: string): NavItem | undefined {
  return TEACHER_MAIN_NAV.find((item) => item.label === label);
}
