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
  // An institution manager published an exam to its audience (prompt 19).
  // The publish freezes content snapshots and the audience size, so the
  // action is recorded with the exam id as the target and a counts-only
  // summary — never student names or question content (AGENTS.md §7).
  "exam.published",
  // An institution manager changed which classes/students an exam is
  // assigned to (prompt 19). Recorded only when the audience actually
  // changed; the detail carries before/after counts, never identities.
  "exam.assignment_changed",
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
  "exam.published": "Published an exam to its assigned audience",
  "exam.assignment_changed": "Changed an exam's class/student assignments",
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

export type PlatformAuditQuery = {
  action: PlatformAuditAction | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** Turn raw searchParams into a safe, bounded audit-list query. An unknown
 *  `action` value filters to nothing rather than to an arbitrary column. */
export function resolvePlatformAuditQuery(searchParams: {
  action?: string | string[];
  page?: string | string[];
}): PlatformAuditQuery {
  const rawAction = firstValue(searchParams.action);
  const parsed = Number.parseInt(firstValue(searchParams.page), 10);
  return {
    action: isPlatformAuditAction(rawAction) ? rawAction : null,
    page: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    pageSize: AUDIT_PAGE_SIZE,
  };
}

/** Build an audit-list URL for a page, preserving the current filter. */
export function auditPageHref(
  base: string,
  query: PlatformAuditQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.action) params.set("action", query.action);
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
