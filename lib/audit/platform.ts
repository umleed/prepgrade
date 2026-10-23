/**
 * Platform audit catalog — pure, dependency-free, and unit-testable (the same
 * layering as roles.ts / permissions.ts / access.ts).
 *
 * WHY THIS EXISTS (prompt 31)
 * The audit table (supabase/migrations/0007_platform_audit_log.sql) accepts
 * any bounded string, so the *meaning* of an action must be pinned in code:
 * a closed catalog means every audited event is a name this team recognises,
 * and a typo or client-influenced string can never invent a new one.
 *
 * WHAT GETS AUDITED
 * Only genuine platform-level operations: entering the super-admin area is
 * itself normal use (not audited), but a DENIED attempt to enter it is a
 * security event and is recorded. Future sensitive actions (institution
 * lifecycle changes, support access — prompts 32/33) add their names here
 * first, so the catalog stays the single inventory of audited actions.
 *
 * PRIVACY (AGENTS.md §7): a detail summary is a short, flat string chosen
 * server-side by trusted code. Never pass user-controlled text, emails,
 * passwords, tokens, or answer material into it — `buildAuditEntry` bounds
 * the length as a backstop, not as permission to log sensitive values.
 */

import type { UserRole } from "../auth/roles.ts";

/** Closed catalog of audited platform actions. */
export const PLATFORM_AUDIT_ACTIONS = [
  // A request to the platform (super-admin) area was denied server-side.
  // Recorded with the trusted role at the time — or 'unassigned' when the
  // session had no resolvable role — so probing is visible without exposing
  // which requirement failed.
  "platform.access_denied",
  // A super admin changed an institution's operational status (prompt 32).
  // Recorded for the approved transition itself (success), a refused/failed
  // attempt, or a denied one — the sensitive tenant-lifecycle write is always
  // auditable, and the detail carries the from→to transition, never personal
  // data. See app/platform/institutions/actions.ts.
  "institution.status_changed",
  // A super admin registered a new institution from the platform area
  // ("Add Institution"). Recorded for the created tenant itself (success,
  // with the new institution id as the target), a duplicate/failed attempt,
  // or a denied one. The detail carries only the controlled-vocabulary type
  // — never the free-text name or contact values (privacy contract above).
  "institution.created",
  // An institution manager published an exam to its audience (prompt 19).
  // The publish freezes content snapshots and the audience size, so the
  // action is recorded with the exam id as the target and a counts-only
  // summary — never student names or question content (AGENTS.md §7).
  "exam.published",
  // An institution manager changed which classes/students an exam is
  // assigned to (prompt 19). Recorded only when the audience actually
  // changed; the detail carries before/after counts, never identities.
  "exam.assignment_changed",
  // A super admin approved a pending institution application (migration 0016).
  // Recorded with the application id as the target and a status-transition
  // summary only — never the applicant's name, email, or phone (privacy
  // contract above). The created tenant id is carried as a short reference.
  "institution_application.approved",
  // A super admin rejected a pending institution application. The detail
  // carries only that a reason was recorded (and its length), never the free-
  // text reason itself, so a rejection motive is not duplicated into the log.
  "institution_application.rejected",
  // A super admin asked an applicant for more information (moves the
  // application to needs_information). Summary carries the transition only.
  "institution_application.info_requested",
  // A super admin PAUSED the review of an open application (0019 on_hold).
  // Not a rejection — the summary carries the transition only, and the
  // recorded hold reason stays on the application row, never in the log.
  "institution_application.placed_on_hold",
  // A super admin's approval provisioned the applicant's workspace access —
  // the first INSTITUTION_ADMIN membership plus the trusted Clerk role were
  // written successfully. Recorded with the application id as the target and a
  // status-only summary; the created tenant id is a short reference. No personal
  // data (privacy contract above).
  "institution_application.access_provisioned",
  // Access provisioning for an approved application did NOT complete (a Clerk
  // or membership write failed), so it was left in a recoverable needs_retry
  // state. The detail carries only a controlled reason token, never an account
  // email/name or a raw error.
  "institution_application.access_provision_failed",
  // An institution admin granted a teacher trusted access to their own tenant
  // (prompt 33: membership/role changes are a sensitive action). Recorded on
  // the successful grant AND on refusals/failures (failed) — the target is the
  // INSTITUTION the membership belongs to, so the platform audit log stays
  // filterable per tenant without ever becoming a tenant-data path. The
  // detail carries the roster-row id reference and outcome only, never the
  // teacher's name or email (privacy contract above).
  "membership.teacher_access_changed",
  // An institution admin revoked a teacher's trusted access (deactivate).
  // Same targeting and privacy contract as the grant event: the tenant is the
  // target, the log carries a roster-row id reference and transition only.
  "membership.teacher_access_revoked",
  // An institution admin changed their own tenant's administrative settings
  // (the Settings › General profile write). Recorded so administrative
  // changes inside a tenant are visible to the platform; the detail names the
  // kind of change only — never the new values (names/contacts stay in the
  // tenant's own row).
  "institution.settings_updated",
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

/** Runtime guard for action strings arriving from any external source
 *  (request payloads, fixtures, rows read back from the database). */
export function isPlatformAuditAction(value: unknown): value is PlatformAuditAction {
  return typeof value === "string" &&
    (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** Outcomes an audited action can have. `denied` is authorization failing;
 *  `failed` is an authorized attempt that did not complete. */
export const PLATFORM_AUDIT_OUTCOMES = ["success", "failed", "denied"] as const;

export type PlatformAuditOutcome = (typeof PLATFORM_AUDIT_OUTCOMES)[number];

export function isPlatformAuditOutcome(value: unknown): value is PlatformAuditOutcome {
  return typeof value === "string" &&
    (PLATFORM_AUDIT_OUTCOMES as readonly string[]).includes(value);
}

/** Role value stored on an audit row. The DB CHECK mirrors this exactly:
 *  the trusted role, `unassigned` (session, no role), or `unknown`
 *  (anonymous — there is no verifiable actor at all). */
export type AuditActorRole = UserRole | "unassigned" | "unknown";

export const AUDIT_ANONYMOUS_ACTOR_ID = "unknown";

/** Bounds mirrored from the 0007 CHECK constraints, so a caller that skips
 *  the data layer still cannot produce a row the database would reject. */
export const AUDIT_LIMITS = {
  actorId: 100,
  action: 80,
  targetType: 60,
  targetId: 100,
  detail: 300,
} as const;

/** Trim and clamp a string to `max` characters; non-strings become `null`. */
function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The fields an audited event carries; everything is server-supplied. */
export type AuditEventInput = {
  /** Clerk user id of the actor, or null for an anonymous request. */
  actorId: string | null;
  /** Trusted role resolved server-side, or null when none was assignable. */
  actorRole: UserRole | null;
  action: PlatformAuditAction;
  targetType?: string | null;
  targetId?: string | null;
  outcome: PlatformAuditOutcome;
  /** Short, trusted, human-readable summary. Never user content or secrets. */
  detail?: string | null;
};

/** A normalised audit row, ready for the data layer. Shaped so the pure
 *  normalisation is unit-testable without Supabase. */
export type NormalisedAuditEntry = {
  created_at: string;
  actor_id: string;
  actor_role: AuditActorRole;
  action: PlatformAuditAction;
  target_type: string | null;
  target_id: string | null;
  outcome: PlatformAuditOutcome;
  detail: { summary: string } | Record<string, never>;
};

/**
 * Normalise an audit event into a database entry. Fail-safe by design: an
 * unknown action or outcome never produces an entry (returns null) instead of
 * guessing, and a missing actor degrades to the `unknown` identity rather
 * than dropping the security event entirely.
 */
export function buildAuditEntry(
  event: AuditEventInput,
  now: Date = new Date(),
): NormalisedAuditEntry | null {
  if (!isPlatformAuditAction(event.action)) return null;
  if (!isPlatformAuditOutcome(event.outcome)) return null;

  const actorId = bounded(event.actorId, AUDIT_LIMITS.actorId);
  const actorRole: AuditActorRole =
    actorId === null ? "unknown" : event.actorRole ?? "unassigned";

  const summary = bounded(event.detail, AUDIT_LIMITS.detail);

  return {
    created_at: now.toISOString(),
    actor_id: actorId ?? AUDIT_ANONYMOUS_ACTOR_ID,
    actor_role: actorRole,
    action: event.action,
    target_type: bounded(event.targetType, AUDIT_LIMITS.targetType),
    target_id: bounded(event.targetId, AUDIT_LIMITS.targetId),
    outcome: event.outcome,
    detail: summary ? { summary } : {},
  };
}

/** Plain-language action labels for the audit-log UI. Unknown stored values
 *  fall back to the raw name — the UI never invents a description. */
export const PLATFORM_AUDIT_ACTION_LABELS: Record<PlatformAuditAction, string> = {
  "platform.access_denied": "Attempted to open platform administration",
  "institution.status_changed": "Changed an institution's operational status",
  "institution.created": "Registered a new institution",
  "exam.published": "Published an exam to its assigned audience",
  "exam.assignment_changed": "Changed an exam's class/student assignments",
  "institution_application.approved": "Approved an institution application",
  "institution_application.rejected": "Rejected an institution application",
  "institution_application.info_requested":
    "Requested more information on an institution application",
  "institution_application.placed_on_hold":
    "Put an institution application on hold",
  "institution_application.access_provisioned":
    "Provisioned the approved applicant's institution access",
  "institution_application.access_provision_failed":
    "Institution access provisioning did not complete (retry available)",
  "membership.teacher_access_changed":
    "Granted a teacher access to the institution",
  "membership.teacher_access_revoked":
    "Revoked a teacher's access to the institution",
  "institution.settings_updated":
    "Updated the institution's settings",
};

export function platformAuditActionLabel(action: string): string {
  return isPlatformAuditAction(action)
    ? PLATFORM_AUDIT_ACTION_LABELS[action]
    : action;
}

// --- List query resolution (filter / pagination) ---------------------------
// Same contract as the other list queries: searchParams are untrusted, so
// everything is clamped or dropped here.

export const AUDIT_PAGE_SIZE = 25;

/** Controlled vocabulary of entity types already written as `target_type` by
 *  trusted server code. The filter dropdown offers exactly these, and an
 *  unknown URL value is dropped rather than passed to a query. `"none"` is
 *  the sentinel for "no target recorded" (e.g. access denials) — a real
 *  token, because an empty option value would collide with "all entities".
 *  Mirrored by the data layer so no client string ever becomes an unbounded
 *  column filter. */
export const AUDIT_ENTITY_TYPES = [
  "none",
  "area",
  "institution",
  "institution_application",
  "exam",
] as const;

/** Outcome filter values — the same closed set stored on rows. */
export const AUDIT_OUTCOME_FILTERS = PLATFORM_AUDIT_OUTCOMES;

export type PlatformAuditQuery = {
  action: PlatformAuditAction | null;
  outcome: PlatformAuditOutcome | null;
  /** Clerk user id filter, trimmed; null drops the filter. */
  actor: string | null;
  /** Institution id filter — matches rows whose target is this tenant. */
  institutionId: string | null;
  /** Entity (`target_type`) filter from the controlled vocabulary; null when
   *  absent or unrecognised. */
  entityType: (typeof AUDIT_ENTITY_TYPES)[number] | null;
  /** Inclusive lower bound (ISO string) on created_at; null when unset. */
  from: string | null;
  /** Exclusive upper bound — the END of the selected day, UTC. */
  to: string | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Parse a `yyyy-mm-dd` date input into a UTC bound. Returns null for
 *  anything malformed so a stray string can never reach a comparison. */
function dateBound(value: string, endOfDay: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Normalise a free-text filter value: trim, drop blanks, bound to the
 *  column's DB length so an over-long value matches nothing rather than
 *  erroring the query. */
function filterValue(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** Turn raw searchParams into a safe, bounded audit-list query. Unknown
 *  `action`/`outcome`/`entityType` values drop the FILTER (fail to "all"),
 *  never to an arbitrary column; malformed dates are dropped the same way. */
export function resolvePlatformAuditQuery(searchParams: {
  action?: string | string[];
  outcome?: string | string[];
  actor?: string | string[];
  institution?: string | string[];
  entity?: string | string[];
  from?: string | string[];
  to?: string | string[];
  page?: string | string[];
}): PlatformAuditQuery {
  const rawAction = firstValue(searchParams.action);
  const rawOutcome = firstValue(searchParams.outcome);
  const rawEntity = firstValue(searchParams.entity);
  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  return {
    action: isPlatformAuditAction(rawAction) ? rawAction : null,
    outcome: isPlatformAuditOutcome(rawOutcome) ? rawOutcome : null,
    actor: filterValue(firstValue(searchParams.actor), AUDIT_LIMITS.actorId),
    institutionId: filterValue(firstValue(searchParams.institution), AUDIT_LIMITS.targetId),
    entityType: (AUDIT_ENTITY_TYPES as readonly string[]).includes(rawEntity)
      ? (rawEntity as (typeof AUDIT_ENTITY_TYPES)[number])
      : null,
    from: dateBound(firstValue(searchParams.from), false),
    to: dateBound(firstValue(searchParams.to), true),
    page: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    pageSize: AUDIT_PAGE_SIZE,
  };
}

/** True when any non-pagination filter is active (for "clear filters" UI). */
export function platformAuditHasFilters(query: PlatformAuditQuery): boolean {
  return (
    query.action !== null ||
    query.outcome !== null ||
    query.actor !== null ||
    query.institutionId !== null ||
    query.entityType !== null ||
    query.from !== null ||
    query.to !== null
  );
}

/** Build an audit-list URL for a page, preserving every active filter. */
export function auditPageHref(
  base: string,
  query: PlatformAuditQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.action) params.set("action", query.action);
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.actor) params.set("actor", query.actor);
  if (query.institutionId) params.set("institution", query.institutionId);
  if (query.entityType !== null) params.set("entity", query.entityType);
  if (query.from) params.set("from", query.from.slice(0, 10));
  if (query.to) params.set("to", query.to.slice(0, 10));
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// --- Institution-scoped activity lookup ------------------------------------
// The platform audit table has no tenant column; the only trustworthy way to
// attribute a row to an institution is the `target_type`/`target_id` pair the
// server wrote when it acted on that tenant (see the status-change action).
// This pure helper pins that shape so the data layer can never build an
// unbounded "all institutions" query from a blank id, and so the scoping rule
// is unit-testable without a database.

/** The `target_type` value written for institution-lifecycle actions. */
export const INSTITUTION_AUDIT_TARGET_TYPE = "institution";

/** Cap the recent-activity list so a detail page never pulls an unbounded set. */
export const INSTITUTION_ACTIVITY_LIMIT = 10;

export type InstitutionActivityFilter = {
  target_type: string;
  target_id: string;
  limit: number;
};

/**
 * Build the equality filter for one institution's audit activity. Returns null
 * for a blank/non-string id so a caller cannot accidentally read the whole
 * platform log — an empty target must resolve to "nothing", never "everything".
 * The limit is clamped to a positive integer within the cap.
 */
export function institutionActivityFilter(
  institutionId: unknown,
  limit: number = INSTITUTION_ACTIVITY_LIMIT,
): InstitutionActivityFilter | null {
  if (typeof institutionId !== "string") return null;
  const targetId = institutionId.trim();
  if (targetId.length === 0) return null;
  const clamped = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), INSTITUTION_ACTIVITY_LIMIT)
    : 1;
  return {
    target_type: INSTITUTION_AUDIT_TARGET_TYPE,
    target_id: targetId,
    limit: clamped,
  };
}

// --- Application-scoped decision history -----------------------------------
// The review drawer shows the decision history for ONE application. Same
// fail-closed rule as the institution activity filter: the only trustworthy
// attribution is the `target_type`/`target_id` pair the server wrote when it
// decided, and a blank id must resolve to "nothing", never the whole log.

/** The `target_type` value written for institution-application decisions. */
export const APPLICATION_AUDIT_TARGET_TYPE = "institution_application";

/**
 * Build the equality filter for one application's decision history. Returns
 * null for a blank/non-string id so a caller cannot read the whole platform
 * log. Reuses the institution activity cap for the limit clamp.
 */
export function applicationActivityFilter(
  applicationId: unknown,
  limit: number = INSTITUTION_ACTIVITY_LIMIT,
): InstitutionActivityFilter | null {
  if (typeof applicationId !== "string") return null;
  const targetId = applicationId.trim();
  if (targetId.length === 0) return null;
  const clamped = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), INSTITUTION_ACTIVITY_LIMIT)
    : 1;
  return {
    target_type: APPLICATION_AUDIT_TARGET_TYPE,
    target_id: targetId,
    limit: clamped,
  };
}
