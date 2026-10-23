/**
 * Institution workspace navigation configuration — pure, dependency-free, and
 * unit-testable (no React, no JSX icons).
 *
 * WHY THIS EXISTS
 * The sidebar used to hardcode its destinations next to their SVG markup, so a
 * routing bug (Exams pointing at the teaching workspace) could not be covered
 * by `npm test` without pulling React into the runner. Keeping the destinations
 * and the active-state rule here means the real navigation contract is the
 * thing under test, and the client component only renders this data.
 *
 * ROUTING CONTRACT (institution navigation & route-ownership repair)
 * - Institution-owned pages live under `/institution/*`.
 * - Exams resolve to `/institution/exams` — the institution's own
 *   exam-management list. Previously this pointed at `/teacher/exams`, which
 *   rendered the teaching workspace shell for an institution admin.
 * - Question Bank now resolves to `/institution/question-bank` — the
 *   institution's own bank list, rendered inside the Institution shell. It
 *   previously pointed at `/teacher/questions`, which dropped an admin into
 *   the teaching workspace sidebar.
 * - Settings resolves to `/institution/settings`, and JAMB/WAEC/NECO resolve
 *   to `/institution/jamb|waec|neco` — all real, institution-owned routes.
 * - Deep authoring lifecycle that would mean forking the entire teaching
 *   workspace (exam builder/publish/monitor/results, question edit/history)
 *   stays SHARED: those routes authorize INSTITUTION_ADMIN server-side and
 *   scope every read to the trusted tenant. The Institution sidebar and its
 *   landing/create actions never render the teaching shell.
 */

import {
  isNavItemActive,
  type NavIconKey,
  type NavItem,
  type NavMatch,
} from "./nav-items.ts";

/**
 * The Institution workspace renders the shared navigation model
 * (`lib/navigation/nav-items.ts`). These aliases keep the institution-facing
 * API name stable while pointing at the single shared definition, so the shell
 * and every test read exactly one contract for item shape and active state.
 */
export type InstitutionNavIconKey = NavIconKey;
export type InstitutionNavItem = NavItem;
export type InstitutionNavMatch = NavMatch;

// Re-exported so the shell/tests import it from this module as before; the
// implementation lives once in the shared model.
export { isNavItemActive };


/* --- Canonical institution-owned destinations -----------------------------
 * Exported so pages, buttons, and tests all reference ONE route string rather
 * than re-typing (and inevitably drifting) a literal. These are the
 * institution-owned workspace pages — none may point into the teaching
 * workspace, per the routing contract above. */

/** The institution exam-management list — the Exams sidebar destination. */
export const INSTITUTION_EXAMS_PATH = "/institution/exams";
/** Institution-owned exam creation (assessment-details) form. */
export const INSTITUTION_EXAMS_NEW_PATH = "/institution/exams/new";
/** Institution-owned question bank list. */
export const INSTITUTION_QUESTION_BANK_PATH = "/institution/question-bank";
/** Institution-owned question creation form. */
export const INSTITUTION_QUESTION_NEW_PATH = "/institution/question-bank/new";
/** Institution-owned bulk question import (prompt 34). */
export const INSTITUTION_QUESTION_IMPORT_PATH = "/institution/question-bank/import";
/** Institution Settings — identity & assessment configuration. */
export const INSTITUTION_SETTINGS_PATH = "/institution/settings";

/**
 * Examination-preparation destinations. The route a category maps to is the
 * SINGLE source both the sidebar and the JAMB/WAEC/NECO pages read, so the
 * nav item and the page it resolves to can never disagree. `code` matches the
 * platform `exam_categories.code` lookup (migration 0005).
 */
export const INSTITUTION_EXAM_PREP_CATEGORIES = [
  "JAMB",
  "WAEC",
  "NECO",
] as const;
export type ExamPrepCode = (typeof INSTITUTION_EXAM_PREP_CATEGORIES)[number];

/** The institution-owned route for one examination-preparation category. */
export function examPrepPath(code: ExamPrepCode): string {
  return `/institution/${code.toLowerCase()}`;
}

export const INSTITUTION_MAIN_NAV: readonly InstitutionNavItem[] = [
  { label: "Dashboard", href: "/institution", icon: "dashboard", match: "exact" },
  { label: "Exams", href: INSTITUTION_EXAMS_PATH, icon: "exams", match: "prefix" },
  { label: "Question Bank", href: INSTITUTION_QUESTION_BANK_PATH, icon: "question-bank", match: "prefix" },
  { label: "Students", href: "/institution/students", icon: "students", match: "prefix" },
  { label: "Teachers", href: "/institution/teachers", icon: "teachers", match: "prefix" },
  { label: "Classes", href: "/institution/classes", icon: "classes", match: "prefix" },
  { label: "Subjects", href: "/institution/subjects", icon: "subjects", match: "prefix" },
  { label: "Results & Analytics", href: "/institution/analytics", icon: "analytics", match: "prefix" },
  { label: "Settings", href: INSTITUTION_SETTINGS_PATH, icon: "settings", match: "prefix" },
];

/**
 * Exam-preparation shortcuts. Each destination is a real, institution-owned
 * route (the JAMB/WAEC/NECO pages read the same `examPrepPath`), so a visible,
 * enabled item never renders disabled and never points into the teaching
 * workspace. The deep authoring/builder flows stay shared (see the header).
 */
export const INSTITUTION_EXAM_PREP_NAV: readonly InstitutionNavItem[] =
  INSTITUTION_EXAM_PREP_CATEGORIES.map((code) => ({
    label: code,
    href: examPrepPath(code),
    icon: code.toLowerCase() as InstitutionNavIconKey,
    match: "exact",
  }));

// `isNavItemActive` (the shared active-state rule) is re-exported above from
// `lib/navigation/nav-items.ts`, so the Institution, Teacher, and Student
// shells can never diverge on what "active" means.

/** Look up an item by label — used by tests and by the shell's aria wiring. */
export function findMainNavItem(label: string): InstitutionNavItem | undefined {
  return INSTITUTION_MAIN_NAV.find((item) => item.label === label);
}
