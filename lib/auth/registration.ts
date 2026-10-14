/**
 * Registration intent — pure, dependency-free, and safe to unit-test.
 *
 * WHAT THIS IS
 * A public sign-up asks every new user one question: "Are you joining PrepGrade
 * as a Student, a Teacher, a CBT Centre, or a School?" The answer is called a
 * `RegistrationIntent`. It is a *user-declared starting point* — nothing more.
 * It is stored in a browser-writable channel (Clerk `unsafeMetadata`) so that
 * the onboarding UI can pick up where the user left off after a reload or an
 * OAuth-only sign-up.
 *
 * WHAT THIS IS NOT
 * A `RegistrationIntent` is NOT a role and NOT a membership. It is never read
 * by `principal.ts`, `access.ts`, or `guards.ts`, and it never grants access to
 * any application area. Authoritative roles — including `INSTITUTION_ADMIN`
 * and `SUPER_ADMIN` — are assigned only by trusted server-side code writing to
 * `privateMetadata` today (see `lib/auth/principal.ts`) and to the tenant
 * schema in prompt 08. A signed-in account with an intent but no trusted role
 * still resolves to `role: null` and is denied every workspace.
 *
 * INTENT → EVENTUAL INTERNAL ROLE MAPPING
 * This is the exact mapping prompt 08 and prompt 31 (super-admin) will enforce
 * during trusted provisioning. It is written here so the UI, the tests, and the
 * provisioning code agree on what each option means.
 *
 *   intent         → eventual authoritative role       provisioning path
 *   --------------   ---------------------------------   ---------------------------------
 *   student          STUDENT (institution-scoped)        Institution admin invites the
 *                                                         user (or accepts their join
 *                                                         request) → server writes
 *                                                         membership + role.
 *   teacher          TEACHER (institution-scoped)        Same as student — invitation or
 *                                                         admin-approved access request.
 *   cbt_centre       INSTITUTION_ADMIN of a CBT-centre   Super admin reviews the
 *                    institution                         registration request → server
 *                                                         provisions the institution +
 *                                                         first admin membership.
 *   school           INSTITUTION_ADMIN of a school       Same as cbt_centre, different
 *                    institution                         institution type.
 *
 * `SUPER_ADMIN` is deliberately absent. It is a platform-scoped role that
 * cannot be selected at sign-up, cannot be inferred from an intent, and is
 * never written from any browser-writable field.
 *
 * Fail-closed invariants (asserted by `tests/auth/registration.test.mts`):
 * 1. Only the four declared intents ever normalise to a non-null value.
 * 2. Any privileged-role string (SUPER_ADMIN, INSTITUTION_ADMIN, admin, owner,
 *    root, …) normalises to `null` — a tampered `unsafeMetadata` cannot select
 *    one, and the picker itself never offers one.
 * 3. No intent maps directly to an authoritative `UserRole`; intents and roles
 *    are separate types with a one-way descriptive link (`intentOutcome`).
 */

export const REGISTRATION_INTENTS = [
  "student",
  "teacher",
  "cbt_centre",
  "school",
] as const;

export type RegistrationIntent = (typeof REGISTRATION_INTENTS)[number];

/** Runtime guard for intent values coming from any external source. */
export function isRegistrationIntent(value: unknown): value is RegistrationIntent {
  return typeof value === "string" &&
    (REGISTRATION_INTENTS as readonly string[]).includes(value);
}

/**
 * Normalise an intent value of unknown shape to a `RegistrationIntent` or
 * `null`. Trims and lower-cases so `" School "` and `"CBT_CENTRE"` both
 * resolve, and folds spaces/hyphens so `"cbt centre"` and `"cbt-centre"` match
 * the canonical spelling. Anything unrecognised — including privileged-role
 * strings like `"SUPER_ADMIN"` or `"INSTITUTION_ADMIN"` — returns `null`
 * rather than guessing a default.
 */
export function normalizeRegistrationIntent(
  value: unknown,
): RegistrationIntent | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return isRegistrationIntent(candidate) ? candidate : null;
}

/**
 * Metadata keys this module owns. Kept in one place for the writer and the
 * reader, and separated from `PRINCIPAL_ROLE_KEY`/`PRINCIPAL_INSTITUTION_KEY`
 * (which live in `privateMetadata` and ARE authoritative).
 */
export const REGISTRATION_INTENT_METADATA_KEY = "registrationIntent";

/**
 * Where an intent ultimately leads, once trusted server-side provisioning
 * happens. This is descriptive — it is only used for UI wording and tests, so
 * a user can honestly see what their choice means; nothing here grants a role.
 *
 * Fields:
 * - `role`: the internal role the account is *expected* to receive, or `null`
 *   while the flow is still awaiting an invitation/approval.
 * - `requires`: the trusted gate that must be satisfied before the role
 *   attaches. Never a client action.
 * - `selfService`: whether the user's own submission can complete provisioning
 *   on its own. Always `false` for MVP — every path requires either an
 *   existing institution's admin or a PrepGrade super admin.
 */
export type IntentOutcome = {
  role: "STUDENT" | "TEACHER" | "INSTITUTION_ADMIN" | null;
  requires: "institution_invitation_or_join_request" | "super_admin_approval";
  selfService: false;
};

export const INTENT_OUTCOMES: Record<RegistrationIntent, IntentOutcome> = {
  student: {
    role: "STUDENT",
    requires: "institution_invitation_or_join_request",
    selfService: false,
  },
  teacher: {
    role: "TEACHER",
    requires: "institution_invitation_or_join_request",
    selfService: false,
  },
  cbt_centre: {
    role: "INSTITUTION_ADMIN",
    requires: "super_admin_approval",
    selfService: false,
  },
  school: {
    role: "INSTITUTION_ADMIN",
    requires: "super_admin_approval",
    selfService: false,
  },
};

/** Human-readable option title, safe to render on the picker. */
export const INTENT_LABELS: Record<RegistrationIntent, string> = {
  student: "Student",
  teacher: "Teacher",
  cbt_centre: "CBT Centre",
  school: "School",
};

/**
 * One-line description rendered under each option. Deliberately honest about
 * what happens next (invitation or approval) so a new user never thinks
 * clicking "School" already provisioned their institution.
 */
export const INTENT_HINTS: Record<RegistrationIntent, string> = {
  student:
    "Prepare for JAMB, WAEC, and NECO. You'll join an existing school or CBT centre once they invite you.",
  teacher:
    "Set questions, run CBT exams, and grade results for the school or centre that invites you.",
  cbt_centre:
    "Run computer-based tests for your centre. Registration is reviewed by the PrepGrade team before your workspace opens.",
  school:
    "Manage your school's assessments, teachers, and students. Registration is reviewed by the PrepGrade team before your workspace opens.",
};

/** Label for an unknown or missing intent value; used in status copy. */
export function intentLabel(intent: RegistrationIntent | null): string {
  return intent ? INTENT_LABELS[intent] : "Not chosen yet";
}

/**
 * Short, honest status line describing what happens after a given intent.
 * Never claims that a workspace is unlocked — the dashboard already shows the
 * no-membership state for every unassigned account.
 */
export function intentNextStep(intent: RegistrationIntent): string {
  switch (intent) {
    case "student":
      return "Wait for your school or CBT centre to invite you, or ask them for a join code.";
    case "teacher":
      return "Ask your school or CBT centre admin to invite you, or request access below.";
    case "cbt_centre":
      return "Submit your centre's details. A PrepGrade super admin approves the registration before your workspace opens.";
    case "school":
      return "Submit your school's details. A PrepGrade super admin approves the registration before your workspace opens.";
  }
}
