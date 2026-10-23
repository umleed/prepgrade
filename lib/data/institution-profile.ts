/**
 * Institution profile data access — SERVER-ONLY.
 *
 * Reads and writes the tenant's own identity/contact record (the migration-0015
 * profile columns on `institutions`) so the Settings › General page shows and
 * edits REAL data. Same trust contract as lib/data/institution-identity.ts:
 * `institutionId` must come from the server-resolved `AuthPrincipal`, never a
 * route param, query string, or client-writable metadata (AGENTS.md §5). The
 * service-role client bypasses RLS, so the `.eq("id", trusted)` filter is the
 * tenant boundary — a forged id can neither read nor write another row.
 *
 * HONEST FAILURES (AGENTS.md §7)
 * A missing env, a DB error, or no matching row each map to a typed status;
 * the page renders an explanatory state rather than a fabricated profile. The
 * write surfaces the database's duplicate-name refusal (migration 0015 unique
 * index) as a friendly reason instead of a raw constraint error. Diagnostics
 * carry identifiers and Postgres codes only — never secrets, keys, or tokens.
 */

import "server-only";
import { createAdminClient, DataSourceUnavailableError } from "@/lib/supabase/server";
import type { InstitutionType } from "@/lib/institutions";
import type { CleanInstitutionProfileUpdate } from "@/lib/institutions";

/** The editable profile as the Settings page uses it (camelCase). */
export type InstitutionProfile = {
  name: string;
  /** Coarse directory type; null when never recorded ("Not set"), never a guess. */
  type: InstitutionType | null;
  shortName: string | null;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
};

export type InstitutionProfileResult =
  | { status: "resolved"; profile: InstitutionProfile }
  /** Trusted tenant id has no matching row in `institutions`. */
  | { status: "missing-record" }
  /** Supabase variables are absent on the server. */
  | { status: "unconfigured" }
  /** The read itself failed (schema not applied, network, etc.). */
  | { status: "unavailable" };

/** Read the tenant's own identity/contact record behind the trusted id. */
export async function getInstitutionProfile(
  institutionId: string,
): Promise<InstitutionProfileResult> {
  const trusted = institutionId?.trim() ?? "";
  if (!trusted) return { status: "missing-record" };

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { status: "unconfigured" };
    }
    console.error("[institution-profile] data source could not be created");
    return { status: "unavailable" };
  }

  const { data, error } = await supabase
    .from("institutions")
    .select(
      "name, institution_type, short_name, description, country, state, city, address, contact_person, contact_email, contact_phone",
    )
    .eq("id", trusted)
    .maybeSingle();

  if (error) {
    console.error("[institution-profile] profile lookup failed", trusted, error.code);
    return { status: "unavailable" };
  }
  if (!data) {
    console.error("[institution-profile] no institutions record for trusted tenant", trusted);
    return { status: "missing-record" };
  }

  const row = data as unknown as {
    name: string | null;
    institution_type: string | null;
    short_name: string | null;
    description: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    address: string | null;
    contact_person: string | null;
    contact_email: string | null;
    contact_phone: string | null;
  };

  return {
    status: "resolved",
    profile: {
      name: row.name ?? "",
      type: isType(row.institution_type),
      shortName: row.short_name,
      description: row.description,
      country: row.country,
      state: row.state,
      city: row.city,
      address: row.address,
      contactPerson: row.contact_person,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
    },
  };
}

export type UpdateInstitutionProfileResult =
  | { ok: true }
  /** Another tenant already holds that (case-insensitive, trimmed) name. */
  | { ok: false; reason: "duplicateName" }
  /** The trusted tenant id matched no row (nothing was written). */
  | { ok: false; reason: "notFound" }
  /** Supabase is not configured on the server. */
  | { ok: false; reason: "unconfigured" }
  /** The write itself failed. */
  | { ok: false; reason: "unavailable" };

/**
 * Write the tenant's own identity/contact record. The input MUST already be the
 * output of `validateInstitutionProfileUpdate` (pure layer) — this trusts its
 * types, not the client. The caller (server action) enforces INSTITUTION_ADMIN
 * and passes only the trusted tenant id; this function performs no auth itself
 * and scopes the update with `.eq("id", trusted)` so it can never touch another
 * institution. Only the validated profile columns are written — `status` and
 * lifecycle columns are schema/platform-owned and are never touched here.
 *
 * The migration-0015 unique index on `lower(btrim(name))` is the real duplicate
 * boundary; a 23505 is surfaced as `duplicateName` rather than thrown.
 */
export async function updateInstitutionProfile(
  institutionId: string,
  update: CleanInstitutionProfileUpdate,
): Promise<UpdateInstitutionProfileResult> {
  const trusted = institutionId?.trim() ?? "";
  if (!trusted) return { ok: false, reason: "notFound" };

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) {
      return { ok: false, reason: "unconfigured" };
    }
    console.error("[institution-profile] data source could not be created for update");
    return { ok: false, reason: "unavailable" };
  }

  const { error, count } = await supabase
    .from("institutions")
    .update(
      {
        name: update.name,
        institution_type: update.type,
        short_name: update.shortName,
        description: update.description,
        country: update.country,
        state: update.state,
        city: update.city,
        address: update.address,
        contact_person: update.contactPerson,
        contact_email: update.contactEmail,
        contact_phone: update.contactPhone,
      },
      { count: "exact" },
    )
    .eq("id", trusted);

  if (error) {
    if (error.code === "23505") {
      return { ok: false, reason: "duplicateName" };
    }
    console.error("[institution-profile] profile update failed", trusted, error.code);
    return { ok: false, reason: "unavailable" };
  }
  if (!count) return { ok: false, reason: "notFound" };

  return { ok: true };
}

/** Narrow the free-text column to the controlled vocabulary, or null. */
function isType(value: string | null): InstitutionType | null {
  if (value === "school" || value === "tutorial_centre" || value === "cbt_centre") {
    return value;
  }
  return null;
}
