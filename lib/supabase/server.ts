/**
 * SERVER-ONLY Supabase client for PrepGrade's tenant data.
 *
 * WHY service-role: authentication is Clerk (lib/auth/context.ts), so the browser
 * never holds a Supabase session and PostgREST has no per-user JWT to evaluate
 * row-level-security claims against. Every read/write therefore goes through this
 * single server-side client, and the DATA LAYER (lib/data/*) is responsible for
 * always scoping queries by the trusted `institution_id` resolved from the
 * session (AGENTS.md §5). Because `service_role` BYPASSES RLS, RLS does NOT
 * scope these queries — tenant isolation for every read/write is enforced by the
 * data layer's `.eq("institution_id", …)` filter, and by nothing else. RLS only
 * guarantees the browser-facing `anon`/`authenticated` roles can never reach
 * these tables directly (supabase/migrations/0002_row_level_security.sql).
 *
 * NEVER import this from a client component: it reads the service-role key, which
 * bypasses RLS and must stay server-side (AGENTS.md §7). The `server-only` import
 * below turns that rule into a build-time failure, not just a convention.
 */

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Thrown when the Supabase env vars are absent so callers can render an honest
 *  "not configured" state instead of failing silently or faking data. */
export class DataSourceUnavailableError extends Error {
  constructor() {
    super(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
    this.name = "DataSourceUnavailableError";
  }
}

/**
 * A service-role client for server-side tenant data access.
 *
 * `auth.persistSession: false` — there is no session to store; the key alone
 * authenticates the request as `service_role`. `global.headers` are safe to set
 * here because this runs only on the server.
 */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new DataSourceUnavailableError();
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
