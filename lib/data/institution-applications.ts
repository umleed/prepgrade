/**
 * Institution applications — SERVER-ONLY data access (migration 0016).
 *
 * SCOPE & AUTHORIZATION. Every function here performs NO auth of its own; the
 * caller must have passed a server-side SUPER_ADMIN check (`requireSuperAdmin`
 * / `inspectAccess`) for the list, detail, summary, and decision reads/writes.
 * The applicant-facing functions (`createInstitutionApplication`,
 * `saveApplicationDraft`, `submitDraftApplication`,
 * `respondToInformationRequest`, `getApplicantApplicationState`) are called
 * from a session-gated route and take the applicant's OWN trusted Clerk user
 * id — never a client-supplied id — and scope every write by it too.
 *
 * SERVICE-ROLE + RLS. The browser cannot reach this table (0016 denies
 * anon/authenticated), so all access is through the service-role client, and
 * the SUPER_ADMIN guard is the enforcement point (AGENTS.md §5).
 *
 * HONEST DATA. Counts use the `MetricState` contract: a failed or missing
 * source is `unavailable`, never a fabricated 0 (same rule as the platform
 * overview). There is no document storage in the product yet, so an
 * application carries no files and the UI says so truthfully.
 */

import "server-only";
import { createAdminClient, DataSourceUnavailableError } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getProvisioningAccount,
  grantInstitutionAdminRole,
} from "@/lib/auth/provisioning";
import {
  canApplyDecision,
  isApplicationStatus,
  isInstitutionType,
  isSelfApplication,
  normalizeProvisioningError,
  normalizeProvisioningStatus,
  toApplicationContainsPattern,
  DECISION_TARGET_STATUS,
  type ApplicationDecision,
  type ApplicationStatus,
  type CleanApplicationDraft,
  type CleanApplicationResponse,
  type CleanApplicationSubmission,
  type ProvisioningErrorCode,
  type ProvisioningStatus,
} from "@/lib/institution-applications";
import {
  createPlatformInstitution,
  type MetricState,
} from "@/lib/data/platform-overview";
import type { InstitutionType } from "@/lib/institutions";

const APPLICATION_SELECT =
  "id, applicant_user_id, institution_name, institution_type, contact_person, contact_email, contact_phone, country, state, city, address, description, status, decided_by, decided_at, rejection_reason, info_request_note, hold_note, applicant_response_note, responded_at, approved_institution_id, provisioning_status, provisioning_error, provisioned_at, created_at, updated_at";

/** Postgres 42P01 / PostgREST PGRST205 — the relation does not exist yet. */
function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

/**
 * Postgres 42703 / PostgREST PGRST204 — the table exists but a referenced
 * column does not, i.e. the database is behind an unapplied migration. This is
 * an operational problem to surface (and fix by applying the migration), never
 * a silent "no application" result.
 */
function isSchemaBehindError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "PGRST204";
}

/** A plain, loggable message for a Supabase/PostgREST error object. */
function describeDbError(error: unknown): string {
  const e = error as { code?: string; message?: string } | null;
  return `${e?.code ?? "unknown"}: ${e?.message ?? "unknown error"}`;
}

type RawApplication = {
  id: string;
  applicant_user_id: string | null;
  institution_name: string | null;
  institution_type: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  description: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
  info_request_note: string | null;
  hold_note: string | null;
  applicant_response_note: string | null;
  responded_at: string | null;
  approved_institution_id: string | null;
  provisioning_status: string | null;
  provisioning_error: string | null;
  provisioned_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A queue row: the columns the table + drawer render, minimally shaped. */
export type ApplicationRow = {
  id: string;
  institutionName: string;
  institutionType: string | null;
  contactPerson: string;
  contactEmail: string;
  submittedAt: string;
  city: string;
  state: string;
  country: string;
  status: ApplicationStatus;
  /** Post-approval workspace-access provisioning state. Only meaningful once
   *  `status` is 'approved'; unapproved rows are always 'not_required'. */
  provisioningStatus: ProvisioningStatus;
};

/** Queue rows are only ever SUBMITTED applications (0019), so the business
 *  fields are present; a legacy NULL would render as an honest blank. */
function textOrBlank(value: string | null): string {
  return value ?? "";
}

/**
 * Narrow a stored row to the full submission payload the approval path needs
 * to CREATE the tenant. 0019 guarantees every non-draft row is complete (the
 * `full_when_not_draft` CHECK) and the decision policy refuses drafts, so a
 * row that still lacks a field is a storage anomaly: the approval is refused
 * rather than guessing values into a real institution record.
 */
function completeSubmissionOf(
  row: RawApplication,
): CleanApplicationSubmission | null {
  if (
    row.institution_name === null ||
    !isInstitutionType(row.institution_type) ||
    row.contact_person === null ||
    row.contact_email === null ||
    row.contact_phone === null ||
    row.country === null ||
    row.state === null ||
    row.city === null ||
    row.address === null
  ) {
    return null;
  }
  return {
    institutionName: row.institution_name,
    institutionType: row.institution_type,
    contactPerson: row.contact_person,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    country: row.country,
    state: row.state,
    city: row.city,
    address: row.address,
    description: row.description,
  };
}

export type ApplicationList = {
  rows: ApplicationRow[];
  total: number;
};

function toRow(row: RawApplication): ApplicationRow {
  return {
    id: row.id,
    institutionName: textOrBlank(row.institution_name),
    institutionType: row.institution_type,
    contactPerson: textOrBlank(row.contact_person),
    contactEmail: textOrBlank(row.contact_email),
    submittedAt: row.created_at,
    city: textOrBlank(row.city),
    state: textOrBlank(row.state),
    country: textOrBlank(row.country),
    // A stored value outside the catalog degrades to pending_review for
    // rendering; the 0016 CHECK makes that impossible in practice.
    status: isApplicationStatus(row.status) ? row.status : "pending_review",
    // Anything unrecognised (or absent, e.g. a pre-0017 row) degrades to
    // 'not_required' — the safe "access not granted" reading.
    provisioningStatus: normalizeProvisioningStatus(row.provisioning_status),
  };
}

/**
 * Paginated, filterable application queue for the SUPER_ADMIN review screen.
 * `q`, `status`, `type`, and `withinDays` come from untrusted searchParams but
 * are already sanitised by `resolveApplicationQueueQuery`; the status/type
 * filters are re-checked here (fail-closed) so a caller that skips the resolver
 * still cannot inject an arbitrary column value.
 */
export async function listInstitutionApplications(query: {
  page: number;
  pageSize: number;
  q?: string;
  status?: ApplicationStatus | null;
  type?: InstitutionType | null;
  withinDays?: number | null;
}): Promise<ApplicationList> {
  const supabase = createAdminClient();

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;

  let builder = supabase
    .from("institution_applications")
    .select(APPLICATION_SELECT, { count: "exact" })
    // Drafts are private to their applicant until submitted (0019) — the
    // review queue NEVER lists them, so an unfinished application cannot be
    // decided or counted by a reviewer.
    .neq("status", "draft");

  const pattern = query.q ? toApplicationContainsPattern(query.q) : "";
  if (pattern) {
    // Search the institution name or the applicant's name (business contact),
    // never the email/phone — keeps personal contact out of query strings.
    builder = builder.or(
      `institution_name.ilike.${pattern},contact_person.ilike.${pattern}`,
    );
  }
  if (query.status && isApplicationStatus(query.status)) {
    builder = builder.eq("status", query.status);
  }
  if (query.type) {
    builder = builder.eq("institution_type", query.type);
  }
  if (query.withinDays && query.withinDays > 0) {
    const cutoff = new Date(Date.now() - query.withinDays * 86_400_000).toISOString();
    builder = builder.gte("created_at", cutoff);
  }

  const { data, error, count } = await builder
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw error;
  const rows = (data ?? []) as unknown as RawApplication[];
  return { rows: rows.map(toRow), total: count ?? 0 };
}

/** Head-count helper (exact count, no rows transferred). The builder type
 *  mirrors platform-overview's `countRows`: filters only chain more `.eq()` /
 *  `.gte()` / `.in()` calls, which every PostgREST builder has. Returns null
 *  on any error so the caller can degrade the whole summary to unavailable. */
type CountBuilder = PromiseLike<{ count: number | null; error: unknown }> & {
  eq: (column: string, value: unknown) => CountBuilder;
  neq: (column: string, value: unknown) => CountBuilder;
  gte: (column: string, value: unknown) => CountBuilder;
  in: (column: string, value: readonly string[]) => CountBuilder;
};

async function countWhere(
  supabase: SupabaseClient,
  apply: (builder: CountBuilder) => CountBuilder,
): Promise<number | null> {
  try {
    const base = supabase
      .from("institution_applications")
      .select("*", { count: "exact", head: true }) as unknown as CountBuilder;
    const { count, error } = await apply(base);
    if (error) return null;
    return count ?? 0;
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) return null;
    return null;
  }
}

export type ApplicationSummaryCounts = {
  pending: number;
  submittedThisWeek: number;
  needsInformation: number;
  reviewedThisMonth: number;
};

/**
 * Live summary counts for the review screen. Every figure is a real filtered
 * count over `institution_applications`; there are no invented week-over-week
 * deltas (no history table). Any failing count degrades the WHOLE result to
 * `unavailable` so a partial breakdown is never shown as if complete.
 */
export async function getApplicationSummaryCounts(): Promise<
  MetricState<ApplicationSummaryCounts>
> {
  let supabase: SupabaseClient;
  try {
    supabase = createAdminClient();
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { state: "unavailable", reason: "error" };
    }
    throw error;
  }

  const weekCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();

  try {
    const [pending, needsInformation, submittedThisWeek, reviewedThisMonth] =
      await Promise.all([
        countWhere(supabase, (b) => b.eq("status", "pending_review")),
        countWhere(supabase, (b) => b.eq("status", "needs_information")),
        // "Submitted this week" counts SUBMITTED applications only — a saved
        // draft is not a submission and must never inflate the figure.
        countWhere(supabase, (b) =>
          b.neq("status", "draft").gte("created_at", weekCutoff),
        ),
        countWhere(supabase, (b) =>
          b.in("status", ["approved", "rejected"]).gte("decided_at", monthStart),
        ),
      ]);

    const parts = [pending, needsInformation, submittedThisWeek, reviewedThisMonth];
    if (parts.some((p) => p === null)) {
      return { state: "unavailable", reason: "error" };
    }

    return {
      state: "available",
      value: {
        pending: pending as number,
        needsInformation: needsInformation as number,
        submittedThisWeek: submittedThisWeek as number,
        reviewedThisMonth: reviewedThisMonth as number,
      },
    };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { state: "unavailable", reason: "error" };
    }
    return {
      state: "unavailable",
      reason: isMissingTableError(error) ? "missing_table" : "error",
    };
  }
}

/** Full detail for the review drawer (single application). */
export type ApplicationDetail = ApplicationRow & {
  contactPhone: string;
  address: string;
  description: string | null;
  applicantUserId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  infoRequestNote: string | null;
  /** Why a reviewer PAUSED the review (put_on_hold), or null. */
  holdNote: string | null;
  /** The applicant's most recent response to an information request. */
  applicantResponseNote: string | null;
  respondedAt: string | null;
  approvedInstitutionId: string | null;
  /** Controlled recovery reason for a partial/failed provisioning, or null. */
  provisioningError: ProvisioningErrorCode | null;
  /** When access became fully ready (null until provisioning succeeds). */
  provisionedAt: string | null;
  updatedAt: string;
};

function toDetail(row: RawApplication): ApplicationDetail {
  return {
    ...toRow(row),
    contactPhone: textOrBlank(row.contact_phone),
    address: textOrBlank(row.address),
    description: row.description,
    applicantUserId: row.applicant_user_id,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    rejectionReason: row.rejection_reason,
    infoRequestNote: row.info_request_note,
    holdNote: row.hold_note,
    applicantResponseNote: row.applicant_response_note,
    respondedAt: row.responded_at,
    approvedInstitutionId: row.approved_institution_id,
    provisioningError: normalizeProvisioningError(row.provisioning_error),
    provisionedAt: row.provisioned_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Read one application's full detail. Returns null when no such application
 * exists. Throws DataSourceUnavailableError when Supabase is unconfigured so
 * the page can render an honest "not configured" state rather than a false
 * "not found". Caller MUST be an authorised SUPER_ADMIN.
 */
export async function getInstitutionApplicationDetail(
  id: string,
): Promise<ApplicationDetail | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("institution_applications")
    .select(APPLICATION_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toDetail(data as unknown as RawApplication);
}

// --- Applicant-facing: own application state + draft / submit / respond -----

/**
 * The applicant's authoritative dashboard record: their most recent
 * application IN ANY STATUS (draft → decided). The one-open-application
 * index means at most one open row exists and it is always the most recently
 * touched one, so `updated_at DESC LIMIT 1` is exactly the record the
 * dashboard must render — never a guess from signup metadata.
 */
export type ApplicantApplicationState = {
  id: string;
  status: ApplicationStatus;
  /** Stored field values, for re-filling the draft/response form. */
  values: CleanApplicationDraft;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  infoRequestNote: string | null;
  holdNote: string | null;
  applicantResponseNote: string | null;
  respondedAt: string | null;
  approvedInstitutionId: string | null;
  /** Only meaningful once status is 'approved' — the dashboard shows the
   *  truth about workspace access, never a premature "welcome aboard". */
  provisioningStatus: ProvisioningStatus;
  provisioningError: ProvisioningErrorCode | null;
};

function valuesOf(row: RawApplication): CleanApplicationDraft {
  return {
    institutionName: row.institution_name ?? "",
    institutionType: isInstitutionType(row.institution_type)
      ? row.institution_type
      : null,
    contactPerson: row.contact_person,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    country: row.country,
    state: row.state,
    city: row.city,
    address: row.address,
    description: row.description,
  };
}

function toApplicantState(row: RawApplication): ApplicantApplicationState {
  return {
    id: row.id,
    status: isApplicationStatus(row.status) ? row.status : "pending_review",
    values: valuesOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    rejectionReason: row.rejection_reason,
    infoRequestNote: row.info_request_note,
    holdNote: row.hold_note,
    applicantResponseNote: row.applicant_response_note,
    respondedAt: row.responded_at,
    approvedInstitutionId: row.approved_institution_id,
    provisioningStatus: normalizeProvisioningStatus(row.provisioning_status),
    provisioningError: normalizeProvisioningError(row.provisioning_error),
  };
}

/**
 * Read the signed-in applicant's own application in ANY status. Returns null
 * when they have never applied (or only a table that does not exist yet).
 * Scoped to the caller's OWN user id — never another applicant's.
 */
export async function getApplicantApplicationState(
  applicantUserId: string,
): Promise<ApplicantApplicationState | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("institution_applications")
    .select(APPLICATION_SELECT)
    .eq("applicant_user_id", applicantUserId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    // Throw a real Error (not the raw PostgREST object, which is not an Error
    // instance and logs as `{}`), naming an unapplied migration when a column
    // is missing so operators know the next step.
    if (isSchemaBehindError(error)) {
      throw new Error(
        "institution_applications is behind on migrations — a referenced column " +
          `does not exist (${describeDbError(error)}). Apply the outstanding Supabase migration.`,
      );
    }
    throw new Error(
      `Failed to read applicant application status (${describeDbError(error)})`,
    );
  }
  if (!data) return null;
  return toApplicantState(data as unknown as RawApplication);
}

/** The draft write is refused when another OPEN application already exists
 *  (only a draft may be edited in place — 0019 duplicate guard). */
export type SaveDraftResult =
  | { ok: true; id: string }
  | { ok: false; reason: "notDraftable" | "error" };

/**
 * Save (create or update) the applicant's DRAFT. A draft is invisible to the
 * review queue and grants nothing; re-saving updates the applicant's own
 * draft row in place instead of piling up rows. The input MUST already be the
 * output of `validateApplicationDraft` (pure layer).
 */
export async function saveApplicationDraft(
  input: CleanApplicationDraft,
  applicantUserId: string,
): Promise<SaveDraftResult> {
  const supabase = createAdminClient();
  const fields = {
    institution_name: input.institutionName,
    institution_type: input.institutionType,
    contact_person: input.contactPerson,
    contact_email: input.contactEmail,
    contact_phone: input.contactPhone,
    country: input.country,
    state: input.state,
    city: input.city,
    address: input.address,
    description: input.description,
  };
  try {
    // The applicant's own OPEN row decides the write: draft → update in place;
    // anything else already under review → refuse (no second open row).
    const { data, error } = await supabase
      .from("institution_applications")
      .select("id, status")
      .eq("applicant_user_id", applicantUserId)
      .in("status", ["draft", "pending_review", "needs_information", "on_hold"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false, reason: "error" };
    const existing = data as { id: string; status: string } | null;

    if (existing && existing.status === "draft") {
      const { error: updateError } = await supabase
        .from("institution_applications")
        .update(fields)
        .eq("id", existing.id)
        .eq("status", "draft")
        .eq("applicant_user_id", applicantUserId);
      if (updateError) return { ok: false, reason: "error" };
      return { ok: true, id: existing.id };
    }
    if (existing) return { ok: false, reason: "notDraftable" };

    const { data: inserted, error: insertError } = await supabase
      .from("institution_applications")
      .insert({ ...fields, applicant_user_id: applicantUserId, status: "draft" })
      .select("id")
      .single();
    if (insertError) {
      // 23505 = a concurrent open application won the unique index.
      if (insertError.code === "23505") {
        return { ok: false, reason: "notDraftable" };
      }
      return { ok: false, reason: "error" };
    }
    return { ok: true, id: (inserted as unknown as { id: string }).id };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { ok: false, reason: "error" };
    }
    return { ok: false, reason: "error" };
  }
}

export type SubmitDraftResult =
  | { ok: true }
  | { ok: false; reason: "notDraft" | "error" };

/**
 * Submit the applicant's own DRAFT as a full application: every business
 * field is written from the ALREADY re-validated payload (a draft is partial
 * by design — submission replaces it entirely) and the row moves to
 * pending_review. Compare-and-swap on status='draft' AND the applicant's own
 * trusted id, so a reviewer decision landing meanwhile fails cleanly with
 * `notDraft` instead of overwriting a decided row.
 */
export async function submitDraftApplication(
  id: string,
  input: CleanApplicationSubmission,
  applicantUserId: string,
): Promise<SubmitDraftResult> {
  const supabase = createAdminClient();
  try {
    const { count, error } = await supabase
      .from("institution_applications")
      .update(
        {
          institution_name: input.institutionName,
          institution_type: input.institutionType,
          contact_person: input.contactPerson,
          contact_email: input.contactEmail,
          contact_phone: input.contactPhone,
          country: input.country,
          state: input.state,
          city: input.city,
          address: input.address,
          description: input.description,
          status: "pending_review",
        },
        { count: "exact" },
      )
      .eq("id", id)
      .eq("status", "draft")
      .eq("applicant_user_id", applicantUserId);
    if (error) return { ok: false, reason: "error" };
    if (!count) return { ok: false, reason: "notDraft" };
    return { ok: true };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { ok: false, reason: "error" };
    }
    return { ok: false, reason: "error" };
  }
}

export type RespondResult =
  | { ok: true }
  | { ok: false; reason: "notActionable" | "error" };

/**
 * Answer a needs_information request on the SAME row: corrected details plus
 * the required response note are written, `responded_at` records the answer,
 * and the application re-enters the queue as pending_review. The reviewer's
 * `info_request_note` is KEPT (a request is never silently replaced by an
 * answer). CAS on status='needs_information' AND the applicant's own id, so
 * a concurrent reviewer decision is refused cleanly.
 */
export async function respondToInformationRequest(
  id: string,
  input: CleanApplicationResponse,
  applicantUserId: string,
): Promise<RespondResult> {
  const supabase = createAdminClient();
  try {
    const { count, error } = await supabase
      .from("institution_applications")
      .update(
        {
          institution_name: input.institutionName,
          institution_type: input.institutionType,
          contact_person: input.contactPerson,
          contact_email: input.contactEmail,
          contact_phone: input.contactPhone,
          country: input.country,
          state: input.state,
          city: input.city,
          address: input.address,
          description: input.description,
          applicant_response_note: input.responseNote,
          responded_at: new Date().toISOString(),
          status: "pending_review",
        },
        { count: "exact" },
      )
      .eq("id", id)
      .eq("status", "needs_information")
      .eq("applicant_user_id", applicantUserId);
    if (error) return { ok: false, reason: "error" };
    if (!count) return { ok: false, reason: "notActionable" };
    return { ok: true };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { ok: false, reason: "error" };
    }
    return { ok: false, reason: "error" };
  }
}

export type CreateApplicationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "duplicateOpen" | "error" };

/**
 * Insert a new application for a signed-in applicant. The input MUST already
 * be the output of `validateApplicationSubmission` (pure layer). The
 * applicant's user id is the trusted session id, never a client value.
 *
 * DUPLICATE PREVENTION: the 0016 partial unique index (widened by 0019) allows
 * only one OPEN application per applicant — draft included. A second
 * submission while one is open returns `duplicateOpen` (mapped from the 23505)
 * rather than piling up rows. A saved draft is submitted through
 * `submitDraftApplication`, not by inserting next to it.
 */
export async function createInstitutionApplication(
  input: CleanApplicationSubmission,
  applicantUserId: string,
): Promise<CreateApplicationResult> {
  const supabase = createAdminClient();
  try {
    const { data, error } = await supabase
      .from("institution_applications")
      .insert({
        applicant_user_id: applicantUserId,
        institution_name: input.institutionName,
        institution_type: input.institutionType,
        contact_person: input.contactPerson,
        contact_email: input.contactEmail,
        contact_phone: input.contactPhone,
        country: input.country,
        state: input.state,
        city: input.city,
        address: input.address,
        description: input.description,
        status: "pending_review",
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") return { ok: false, reason: "duplicateOpen" };
      return { ok: false, reason: "error" };
    }
    return { ok: true, id: (data as unknown as { id: string }).id };
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { ok: false, reason: "error" };
    }
    return { ok: false, reason: "error" };
  }
}

// --- Reviewer decision (the sensitive write) --------------------------------

export type DecideResult =
  | {
      ok: true;
      status: ApplicationStatus;
      /** True when the application was already in this terminal state. */
      alreadyDecided: boolean;
      approvedInstitutionId: string | null;
      /** Result of granting the applicant's workspace access (approval only).
       *  'not_required' for reject/request_information. The caller must treat
       *  anything other than 'provisioned' as NOT full success — the decision
       *  was recorded but access is not yet usable. */
      provisioning: ProvisioningStatus;
      /** Controlled recovery reason when provisioning did not complete. */
      provisioningError: ProvisioningErrorCode | null;
    }
  | {
      ok: false;
      reason:
        | "notFound"
        | "conflict"
        | "invalidTransition"
        | "duplicateName"
        | "selfApproval"
        | "incompleteRecord"
        | "error";
    };

/** The recorded outcome of one provisioning attempt (shared by approve + retry). */
type ProvisioningOutcome = {
  provisioning: ProvisioningStatus;
  provisioningError: ProvisioningErrorCode | null;
};

/**
 * Apply a reviewer decision to one application.
 *
 * CONCURRENCY (compare-and-swap, claim-then-act): the current status is read
 * server-side and the write is CONDITIONAL on it (`.eq("status", current)`
 * with an exact affected-row count). A concurrent decision matches zero rows
 * and reports `conflict`, so two operators can never both approve, or approve
 * and reject, the same application.
 *
 * APPROVAL creates the tenant via `createPlatformInstitution`, then PROVISIONS
 * the applicant's workspace access (first INSTITUTION_ADMIN membership + the
 * trusted Clerk role) via `provisionAndRecord`. Only the CAS winner reaches
 * these steps. If the tenant name is already taken the claim is reverted so the
 * application is NOT left approved without a tenant (0015 name-uniqueness is the
 * final duplicate guard). Provisioning runs AFTER the tenant is linked, and a
 * partial failure (membership saved but the Clerk write failed, or the reverse)
 * is recorded as a recoverable `needs_retry` state — NEVER reported as full
 * success. Re-approving an already-approved row is idempotent: it short-circuits
 * when access is already `provisioned`, otherwise it re-runs the membership +
 * Clerk upserts without creating a second tenant.
 *
 * SELF-APPROVAL: a reviewer's own account can never approve or provision their
 * own application (`isSelfApplication`), preventing minting access to a pending
 * submission you submitted yourself.
 *
 * The caller (server action) enforces SUPER_ADMIN and validates the note before
 * calling; this function trusts its types, not the client.
 */
export async function decideInstitutionApplication(
  id: string,
  decision: ApplicationDecision,
  note: string | null,
  actorUserId: string,
): Promise<DecideResult> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("institution_applications")
    .select(APPLICATION_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, reason: "error" };
  if (!data) return { ok: false, reason: "notFound" };

  const current = data as unknown as RawApplication;
  if (!isApplicationStatus(current.status)) {
    return { ok: false, reason: "notFound" };
  }
  const status = current.status;

  // Self-approval guard (approve only): a reviewer must not approve/provision
  // the application belonging to their OWN applicant account.
  if (
    decision === "approve" &&
    isSelfApplication(current.applicant_user_id, actorUserId)
  ) {
    return { ok: false, reason: "selfApproval" };
  }

  // Idempotent re-approve: already approved → never create a second tenant. If
  // access is already provisioned, report it without extra Clerk work;
  // otherwise complete/repair provisioning (safe, idempotent upserts).
  if (decision === "approve" && status === "approved") {
    if (normalizeProvisioningStatus(current.provisioning_status) === "provisioned") {
      return {
        ok: true,
        status: "approved",
        alreadyDecided: true,
        approvedInstitutionId: current.approved_institution_id,
        provisioning: "provisioned",
        provisioningError: null,
      };
    }
    const provisioning = await provisionAndRecord(supabase, {
      id,
      applicantUserId: current.applicant_user_id,
      institutionId: current.approved_institution_id,
      contactEmail: current.contact_email,
      contactPerson: current.contact_person,
    });
    return {
      ok: true,
      status: "approved",
      alreadyDecided: true,
      approvedInstitutionId: current.approved_institution_id,
      ...provisioning,
    };
  }

  // Fail-closed transition policy.
  if (!canApplyDecision(status, decision)) {
    return { ok: false, reason: "invalidTransition" };
  }

  const target = DECISION_TARGET_STATUS[decision];
  const decidedAt = new Date().toISOString();

  if (decision === "approve") {
    // Approving writes a REAL institution record — every business field must
    // be present (0019 guarantees this for submitted rows; drafts cannot
    // reach here via the policy above, so a null is a storage anomaly).
    const submission = completeSubmissionOf(current);
    if (!submission) {
      return { ok: false, reason: "incompleteRecord" };
    }

    // 1. Claim: move to approved (conditional on the status we just read).
    const claim = await supabase
      .from("institution_applications")
      .update(
        { status: "approved", decided_by: actorUserId, decided_at: decidedAt },
        { count: "exact" },
      )
      .eq("id", id)
      .eq("status", status);
    if (claim.error) {
      await rollbackClaim(supabase, id);
      return { ok: false, reason: "error" };
    }
    if (!claim.count) {
      return { ok: false, reason: "conflict" };
    }

    // 2. Create the tenant (no membership, no email). Duplicate name → revert.
    let created;
    try {
      created = await createPlatformInstitution({
        name: submission.institutionName,
        type: submission.institutionType,
        shortName: null,
        description: current.description,
        country: submission.country,
        state: submission.state,
        city: submission.city,
        address: submission.address,
        contactPerson: submission.contactPerson,
        contactEmail: submission.contactEmail,
        contactPhone: submission.contactPhone,
      });
    } catch {
      await rollbackClaim(supabase, id);
      return { ok: false, reason: "error" };
    }
    if (!created.ok) {
      await rollbackClaim(supabase, id);
      return { ok: false, reason: "duplicateName" };
    }

    // 3. Link the created tenant to the (already-claimed) approved row.
    await supabase
      .from("institution_applications")
      .update({ approved_institution_id: created.id })
      .eq("id", id)
      .eq("status", "approved");

    // 4. Provision the applicant's workspace access (membership + trusted
    //    Clerk role). A partial failure is recorded as recoverable needs_retry;
    //    the approval stays committed and is never falsely reported as full
    //    success while access is not ready.
    const provisioning = await provisionAndRecord(supabase, {
      id,
      applicantUserId: current.applicant_user_id,
      institutionId: created.id,
      contactEmail: current.contact_email,
      contactPerson: current.contact_person,
    });

    return {
      ok: true,
      status: "approved",
      alreadyDecided: false,
      approvedInstitutionId: created.id,
      ...provisioning,
    };
  }

  // Reject / request_information: a single conditional write.
  const patch: Record<string, unknown> = {
    status: target,
    decided_by: actorUserId,
    decided_at: decidedAt,
  };
  if (decision === "reject") patch.rejection_reason = note;
  if (decision === "request_information") patch.info_request_note = note;
  // The hold reason lives in its OWN column so pausing a review never
  // overwrites an earlier information request (0019).
  if (decision === "put_on_hold") patch.hold_note = note;

  const { error: updateError, count } = await supabase
    .from("institution_applications")
    .update(patch, { count: "exact" })
    .eq("id", id)
    .eq("status", status);
  if (updateError) return { ok: false, reason: "error" };
  if (!count) return { ok: false, reason: "conflict" };

  return {
    ok: true,
    status: target,
    alreadyDecided: false,
    approvedInstitutionId: null,
    // No workspace access is provisioned for a rejection / information request.
    provisioning: "not_required",
    provisioningError: null,
  };
}

/**
 * Undo an approval claim that could not be completed (e.g. the tenant name was
 * taken). Only reverts a row that is still 'approved' with no linked tenant,
 * so it never clobbers a fully-committed approval.
 */
async function rollbackClaim(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  try {
    await supabase
      .from("institution_applications")
      .update({
        status: "needs_information",
        decided_by: null,
        decided_at: null,
        info_request_note:
          "Approval could not be completed automatically (the institution name may already exist). Please review and retry.",
      })
      .eq("id", id)
      .eq("status", "approved")
      .is("approved_institution_id", null);
  } catch {
    // Best-effort revert; a failure here is surfaced via the audit trail and
    // the operator message, never silently swallowed at the call site.
  }
}

// --- Applicant access provisioning (post-approval) --------------------------
//
// Approval creates the tenant; these functions attach the applicant to it as
// the first INSTITUTION_ADMIN and write the trusted Clerk role the auth stack
// reads (lib/auth/context.ts → principal.ts). Supabase and Clerk cannot share
// one atomic transaction, so the outcome is a DURABLE, RECOVERABLE state:
//   • DB membership is written BEFORE the Clerk metadata, so the classic partial
//     failure (membership lands, Clerk write fails) is recorded as needs_retry
//     with clerk_metadata_failed and re-run safely (all writes idempotent).
//   • The applicant's OWN trusted Clerk user id (row.applicant_user_id) is the
//     only identity used — never a client-supplied id, and never a role inferred
//     from untrusted signup metadata.

/**
 * Provision (or repair) an approved applicant's workspace access. Returns the
 * resulting state; NEVER throws for an ordinary failure so an approval is not
 * lost to a partial grant. Idempotent: re-running after a success or a failure
 * produces no duplicate tenant/membership.
 */
export async function provisionApplicantAccess(
  supabase: SupabaseClient,
  input: {
    applicantUserId: string | null;
    institutionId: string | null;
    /** Stored business contact — only a FALLBACK when the Clerk account
     *  carries no email/name. Nullable because drafts relax those NOT NULLs
     *  (0019); a fully-blank identity is refused below, never guessed. */
    contactEmail: string | null;
    contactPerson: string | null;
  },
): Promise<{ status: ProvisioningStatus; error: ProvisioningErrorCode | null }> {
  // 1. The tenant must exist (approval created it). With no institution there
  //    is nothing to attach a membership to — a recoverable, visible gap.
  if (!input.institutionId) {
    return { status: "needs_retry", error: "tenant_missing" };
  }

  // 2. The applicant identity must resolve. applicant_user_id is the trusted
  //    Clerk user id captured at submission; a blank id grants nothing.
  const applicantUserId = input.applicantUserId?.trim();
  if (!applicantUserId) {
    return { status: "needs_retry", error: "applicant_missing" };
  }

  // 3. Read the Clerk account + its CURRENT trusted grant BEFORE any write, so
  //    a conflict or a missing account never leaves a stray DB membership.
  let account;
  try {
    account = await getProvisioningAccount(applicantUserId);
  } catch {
    // No CLERK_SECRET_KEY or a BAPI fault: access cannot be granted now, but
    // the state is retryable.
    return { status: "needs_retry", error: "clerk_metadata_failed" };
  }
  if (!account) {
    return { status: "needs_retry", error: "applicant_missing" };
  }
  if (account.role !== null && account.role !== "INSTITUTION_ADMIN") {
    return { status: "needs_retry", error: "role_conflict" };
  }
  if (
    account.role === "INSTITUTION_ADMIN" &&
    account.institutionId !== input.institutionId
  ) {
    return { status: "needs_retry", error: "role_conflict" };
  }

  // An email is required for the profile mirror; the Clerk account wins and
  // the stored business contact is the fallback. No address at all → nothing
  // can be honestly written — recoverable, visible, and retried later.
  const email = account.email ?? input.contactEmail;
  if (!email) {
    return { status: "needs_retry", error: "applicant_missing" };
  }
  const fullName = account.fullName ?? input.contactPerson ?? email;

  // 4. Database membership FIRST (idempotent upserts). If this fails nothing was
  //    granted and Clerk is untouched.
  try {
    await upsertApplicantAdminMembership(supabase, {
      institutionId: input.institutionId,
      userId: applicantUserId,
      email,
      fullName,
    });
  } catch {
    return { status: "needs_retry", error: "membership_write_failed" };
  }

  // 5. Then the trusted Clerk metadata the resolver reads today. A failure here
  //    (DB membership present but Clerk not written) is the textbook partial
  //    state → needs_retry/clerk_metadata_failed, retried idempotently.
  try {
    await grantInstitutionAdminRole(applicantUserId, input.institutionId);
  } catch {
    return { status: "needs_retry", error: "clerk_metadata_failed" };
  }

  return { status: "provisioned", error: null };
}

/**
 * Write the DB mirror rows for the applicant's admin membership. `profiles` is
 * the server-written mirror of the Clerk account (0001); the membership FK
 * (user_id → profiles.id) requires it, so ensure it first. Both upserts are
 * `ignoreDuplicates:false` ON CONFLICT so a retry updates in place rather than
 * erroring or duplicating — the same trusted-provisioning pattern teachers.ts
 * uses for TEACHER links. Never touches another tenant's membership (the
 * conflict was caught in provisionApplicantAccess step 3 before any write).
 */
async function upsertApplicantAdminMembership(
  supabase: SupabaseClient,
  input: { institutionId: string; userId: string; email: string; fullName: string },
): Promise<void> {
  const { error: profileError } = await supabase
    .from("profiles")
    .upsert(
      {
        id: input.userId,
        email: input.email,
        full_name: input.fullName,
        account_type: "school",
      },
      { onConflict: "id", ignoreDuplicates: false },
    );
  if (profileError) throw profileError;

  const { error: membershipError } = await supabase
    .from("institution_memberships")
    .upsert(
      {
        institution_id: input.institutionId,
        user_id: input.userId,
        role: "INSTITUTION_ADMIN",
        status: "active",
      },
      { onConflict: "institution_id,user_id", ignoreDuplicates: false },
    );
  if (membershipError) throw membershipError;
}

/** Persist the provisioning outcome on the (approved) application row. Scoped
 *  to status='approved' so a non-approved row can never claim provisioning. */
async function writeProvisioningState(
  supabase: SupabaseClient,
  id: string,
  status: ProvisioningStatus,
  error: ProvisioningErrorCode | null,
): Promise<void> {
  const { error: updateError } = await supabase
    .from("institution_applications")
    .update({
      provisioning_status: status,
      provisioning_error: error,
      provisioned_at: status === "provisioned" ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .eq("status", "approved");
  if (updateError) throw updateError;
}

/**
 * Run provisioning for one approved application and RECORD the outcome. The
 * returned state comes from the live provisioning result (authoritative for
 * "is access ready"), so a bookkeeping write failure — e.g. migration 0017 not
 * yet applied to this environment — never turns a not-ready state into a
 * reported success, nor fails an otherwise-completed decision.
 */
async function provisionAndRecord(
  supabase: SupabaseClient,
  application: {
    id: string;
    applicantUserId: string | null;
    institutionId: string | null;
    contactEmail: string | null;
    contactPerson: string | null;
  },
): Promise<ProvisioningOutcome> {
  const result = await provisionApplicantAccess(supabase, application);
  try {
    await writeProvisioningState(
      supabase,
      application.id,
      result.status,
      result.error,
    );
  } catch {
    // Best-effort bookkeeping: the returned in-memory state is what the caller
    // audits and surfaces, so the operator still sees the true access state.
  }
  return { provisioning: result.status, provisioningError: result.error };
}

/**
 * Re-run applicant access provisioning for an ALREADY-APPROVED application
 * (idempotent). The caller (server action) enforces SUPER_ADMIN first.
 *
 * This is the ONE place the retry path decides eligibility, and it mirrors the
 * approval guards so a client cannot bypass them: it refuses when the
 * application is missing, is not in the 'approved' state, or belongs to the
 * acting reviewer's OWN applicant account (self-provisioning). A row already
 * 'provisioned' short-circuits without extra Clerk work.
 */
export type RetryProvisioningResult =
  | {
      ok: true;
      provisioning: ProvisioningStatus;
      provisioningError: ProvisioningErrorCode | null;
    }
  | { ok: false; reason: "notFound" | "notApproved" | "selfProvision" };

export async function retryApplicationProvisioning(
  id: string,
  actorUserId: string,
): Promise<RetryProvisioningResult> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("institution_applications")
    .select(APPLICATION_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "notFound" };

  const current = data as unknown as RawApplication;
  if (current.status !== "approved") return { ok: false, reason: "notApproved" };

  // Self-provisioning guard mirrors the approval guard: a reviewer must not
  // (re)grant workspace access on their OWN application.
  if (isSelfApplication(current.applicant_user_id, actorUserId)) {
    return { ok: false, reason: "selfProvision" };
  }

  if (normalizeProvisioningStatus(current.provisioning_status) === "provisioned") {
    return { ok: true, provisioning: "provisioned", provisioningError: null };
  }

  const outcome = await provisionAndRecord(supabase, {
    id,
    applicantUserId: current.applicant_user_id,
    institutionId: current.approved_institution_id,
    contactEmail: current.contact_email,
    contactPerson: current.contact_person,
  });
  return { ok: true, ...outcome };
}
