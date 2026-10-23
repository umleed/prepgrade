/**
 * Platform moderation presentation — pure, dependency-free, unit-testable.
 *
 * WHY THIS EXISTS (and what it deliberately is NOT)
 * The Super Admin "Moderation" area is READ-ONLY visibility built ONLY from
 * data that already exists:
 *   1. the question lifecycle as it is actually stored — `status IN
 *      ('active','archived')` (migration 0006) — surfaced as a status filter;
 *   2. real platform audit events, read through the established audit reader.
 *
 * There is NO review queue, NO approve/reject/hold state, NO moderation
 * report, and NO history table in this schema, so none is modelled here. This
 * module adds no invented lifecycle and no write action. It only decides how a
 * genuine stored value is filtered and displayed — the same contract-sharing
 * layering as lib/platform-settings.ts and lib/plans.ts.
 *
 * AUDIT EVENTS ARE NOT "REPORTS"
 * The audit rows shown on the screen are governance/security records written by
 * trusted server code (see lib/audit/platform.ts). Presenting them here is a
 * re-skin of the same immutable log the Audit Log page shows; the wording must
 * never imply a submitted report or a pending review.
 *
 * TYPES ARE RE-DECLARED, NOT IMPORTED FROM SERVER-ONLY MODULES
 * lib/data/audit.ts imports `server-only`; its `PlatformAuditEntry` shape is
 * mirrored structurally below so the pure layer loads under the Node runner.
 */

import { platformAuditActionLabel } from "./audit/platform.ts";

// --- Question status tabs -------------------------------------------------------

/** The only visibility states the stored lifecycle supports today. */
export const MODERATION_STATUS_TABS = ["all", "active", "archived"] as const;

export type ModerationStatusTab = (typeof MODERATION_STATUS_TABS)[number];

/**
 * Resolve a tab from untrusted searchParams. Anything unrecognised fails
 * closed to "all" — never to an arbitrary column value, and never to a status
 * that does not exist in the schema.
 */
export function resolveModerationTab(value: unknown): ModerationStatusTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return (MODERATION_STATUS_TABS as readonly string[]).includes(String(raw))
    ? (raw as ModerationStatusTab)
    : "all";
}

export const MODERATION_TAB_LABELS: Record<ModerationStatusTab, string> = {
  all: "All questions",
  active: "Active",
  archived: "Archived",
};

/**
 * The `status` value this tab implies for the shared question reader: "all"
 * means no status filter (null), the concrete tabs pass their status through.
 */
export function moderationTabToStatusFilter(
  tab: ModerationStatusTab,
): "active" | "archived" | null {
  return tab === "all" ? null : tab;
}

/**
 * Build a moderation URL for a tab. The `status` param carries the tab; other
 * active narrowing (institution, source search) is threaded through by the
 * caller via the shared question-directory href builder, so a tab switch never
 * silently leaks a stale status.
 */
export function moderationTabHref(base: string, tab: ModerationStatusTab): string {
  if (tab === "all") return base;
  return `${base}?status=${tab}`;
}

// --- Audit event presentation ---------------------------------------------------

/** Structural mirror of the server `PlatformAuditEntry`. */
export type AuditEventLike = {
  id: number;
  createdAt: string;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  summary: string | null;
};

export type AuditEventTone = "success" | "warning" | "danger" | "neutral";

/** The three stored outcomes map to fixed tones; anything unexpected is
 *  neutral, never a confident colour for a value this layer cannot name. */
const OUTCOME_TONES: Record<string, AuditEventTone> = {
  success: "success",
  failed: "warning",
  denied: "danger",
};

export type AuditEventView = {
  id: number;
  createdAt: string;
  /** Plain-language label from the shared audit catalog — the UI never
   *  invents a description for a value it cannot name. */
  actionLabel: string;
  actionRaw: string;
  actorRole: string;
  outcome: string;
  outcomeTone: AuditEventTone;
  summary: string | null;
  /** Compact "target_type · short-id" reference, or null. */
  target: string | null;
};

/**
 * Map one stored audit row to a safe display view. The action label comes from
 * the trusted catalog (`platformAuditActionLabel`); a stored value outside that
 * catalog falls back to the raw name rather than a fabricated description.
 */
export function presentAuditEvent(entry: AuditEventLike): AuditEventView {
  const target = entry.targetType
    ? entry.targetId
      ? `${entry.targetType} · ${shortId(entry.targetId)}`
      : entry.targetType
    : null;
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    actionLabel: platformAuditActionLabel(entry.action),
    actionRaw: entry.action,
    actorRole: entry.actorRole,
    outcome: entry.outcome,
    outcomeTone: OUTCOME_TONES[entry.outcome] ?? "neutral",
    summary: entry.summary,
    target,
  };
}

/** Truncate an id reference so a wide target column never overflows; keeps
 *  the head, which is enough to eyeball an identity without a full read. */
export function shortId(id: string): string {
  const trimmed = id.trim();
  return trimmed.length > 8 ? `${trimmed.slice(0, 8)}…` : trimmed;
}
