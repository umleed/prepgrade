/**
 * SERVER-ONLY read for the Super Admin subscription-plans screen.
 *
 * There is NO plan table in the current schema (migrations 0001–0017):
 * billing and subscriptions are a future phase (prompt 46). Rather than
 * hard-coding a claim or inventing rows, this runs the same live head-count
 * probe pattern the platform overview uses for not-yet-built subsystems
 * (see the `exams` metric in platform-overview.ts): today the query returns
 * the genuine missing-table state, and if a plans migration is ever applied
 * (with owner approval), this screen starts reporting the real catalogue
 * with no code change.
 *
 * SERVICE-ROLE SCOPE (AGENTS.md §5, §7): a cross-tenant read with no
 * institution filter, so the caller MUST be an authorised SUPER_ADMIN
 * (requireSuperAdmin, enforced in the platform layout and again on the
 * page). Only a row count leaves the database — no plan columns are
 * selected, because the column set of a future plans table is not something
 * this screen may guess.
 */

import "server-only";
import {
  createAdminClient,
  DataSourceUnavailableError,
} from "@/lib/supabase/server";
import { isMissingTableError } from "./platform-overview";
import type { PlansProbe } from "@/lib/plans";

/** Table a future billing migration would create. It does not exist today —
 *  probing it anyway is what keeps the screen's "not implemented" statement
 *  verifiable rather than asserted. */
export const SUBSCRIPTION_PLANS_TABLE = "subscription_plans";

/** Exact head count of plan rows, degraded to a state on any failure.
 *  Never throws for a missing table or a query error — the page renders
 *  whichever truth came back via `resolvePlansViewState` (lib/plans.ts). */
export async function getSubscriptionPlansProbe(): Promise<PlansProbe> {
  try {
    const supabase = createAdminClient();
    const { count, error } = await supabase
      .from(SUBSCRIPTION_PLANS_TABLE)
      .select("*", { count: "exact", head: true });

    if (error) {
      return {
        state: "unavailable",
        reason: isMissingTableError(error) ? "missing_table" : "error",
      };
    }
    return { state: "available", value: count ?? 0 };
  } catch (error) {
    // Unconfigured/unreachable Supabase is a data-source error, not a
    // statement about the schema — reason "error" keeps the two apart.
    if (error instanceof DataSourceUnavailableError) {
      return { state: "unavailable", reason: "error" };
    }
    return {
      state: "unavailable",
      reason: isMissingTableError(error) ? "missing_table" : "error",
    };
  }
}
