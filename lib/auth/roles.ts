/**
 * PrepGrade role model — pure, dependency-free, and safe to unit-test.
 *
 * This module intentionally imports nothing (no Clerk, no Next). Role *identity*
 * comes from `lib/auth/principal.ts` and the access decision engine lives in
 * `lib/auth/access.ts`; keeping the three layers separate is what lets the
 * authorization matrix be tested without a browser, a session, or a database.
 *
 * Roles are the four primary PrepGrade roles from AGENTS.md §5. A role is an
 * authorization input, never a UI preference: route hiding is not protection.
 */

export const USER_ROLES = [
  "SUPER_ADMIN",
  "INSTITUTION_ADMIN",
  "TEACHER",
  "STUDENT",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Application areas that later prompts build out. Each area is owned by the
 * role(s) allowed to enter it, so a page or route handler can ask one question —
 * "may this role be in this area?" — instead of scattering role comparisons.
 *
 * - `platform`   → super-admin dashboards (prompt 31).
 * - `institution`→ school/admin management (prompts 10–14, 28).
 * - `teacher`    → teacher workspace (prompt 26).
 * - `student`    → student workspace (prompt 20).
 */
export const APP_AREAS = [
  "platform",
  "institution",
  "teacher",
  "student",
] as const;

export type AppArea = (typeof APP_AREAS)[number];

/** Runtime guard for role strings arriving from any external source. */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" &&
    (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Normalise a role value of unknown shape (metadata, env var, fixture) to a
 * `UserRole` or `null`. Trims and upper-cases so `" teacher "` and `"TEACHER"`
 * both resolve, but anything unrecognised returns `null` rather than guessing a
 * default — an unknown role must never inherit permissions.
 */
export function normalizeUserRole(value: unknown): UserRole | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toUpperCase().replace(/[-\s]+/g, "_");
  return isUserRole(candidate) ? candidate : null;
}

/**
 * Post-login destination per role — the single routing spine.
 *
 * INSTITUTION_ADMIN now has its dedicated workspace (prompt 10) and is routed
 * straight there. SUPER_ADMIN has the platform operations dashboard (prompt
 * 31). STUDENT has the student dashboard (prompt 20) under /student. TEACHER
 * still lands on `/dashboard`, which renders the shared workspace; when the
 * teacher dashboard ships (prompt 26) its row below becomes the real path and
 * no call site needs to change.
 */
export const ROLE_HOME_PATH: Record<UserRole, string> = {
  SUPER_ADMIN: "/platform",
  INSTITUTION_ADMIN: "/institution",
  TEACHER: "/dashboard",
  STUDENT: "/student",
};

/**
 * Home path for a resolved role. An unresolved role (`null` — signed in but with
 * no trusted role assignment yet) also reports `/dashboard`, where the page
 * renders the explicit no-membership state instead of leaking any workspace.
 */
export function roleHomePath(role: UserRole | null): string {
  return role ? ROLE_HOME_PATH[role] : "/dashboard";
}

/**
 * Authoritative area matrix. SUPER_ADMIN is deliberately NOT granted the
 * tenant areas: super-admin actions must be limited and auditable (AGENTS.md
 * §5), so a platform role gets the platform area only and reaches tenant data
 * through explicitly audited super-admin screens, not by inheriting admin rights.
 */
export const ROLE_AREAS: Record<UserRole, readonly AppArea[]> = {
  SUPER_ADMIN: ["platform"],
  INSTITUTION_ADMIN: ["institution", "teacher"],
  TEACHER: ["teacher"],
  STUDENT: ["student"],
};

/** Whether a role may enter an application area. Unknown roles: never. */
export function canAccessArea(
  role: UserRole | null,
  area: AppArea,
): boolean {
  if (!role) return false;
  return ROLE_AREAS[role].includes(area);
}

/** Plain-language area names, so the dashboard can describe a role's scope honestly. */
export const AREA_LABELS: Record<AppArea, string> = {
  platform: "Platform administration",
  institution: "Institution management",
  teacher: "Teaching workspace",
  student: "Student workspace",
};

/** Areas a role may enter, in declaration order (for honest navigation lists). */
export function accessibleAreas(role: UserRole | null): readonly AppArea[] {
  if (!role) return [];
  return ROLE_AREAS[role];
}

/** Human-readable role label for dashboards and audit-friendly UI copy. */
export function roleLabel(role: UserRole | null): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "Super admin";
    case "INSTITUTION_ADMIN":
      return "Institution admin";
    case "TEACHER":
      return "Teacher";
    case "STUDENT":
      return "Student";
    default:
      return "Unassigned";
  }
}
