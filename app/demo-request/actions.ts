"use server";

import {
  validateDemoRequest,
  type DemoRequestInput,
  type DemoRequestErrors,
} from "@/lib/demo-request";

export type DemoRequestResult =
  | { ok: true }
  | { ok: false; errors: DemoRequestErrors };

/**
 * Handle a demo-request submission.
 *
 * SECURITY / TRUST BOUNDARIES
 * - All input is re-validated here on the server; the client's validation is
 *   only for UX. We never trust what the browser sent.
 * - The `website` field is a hidden honeypot. Bots that fill it are accepted
 *   *silently* (we return success so they don't learn they were filtered) but
 *   nothing is stored.
 *
 * DEVELOPMENT-SAFE PLACEHOLDER — READ BEFORE PRODUCTION
 * No approved backend destination is configured yet (no database / CRM / email
 * provider is installed in this repo — see AGENTS.md §3 and prompt 08). Until
 * one exists, submissions are written to the SERVER console only and no
 * personal data is persisted. Before launch, replace the marked block with ONE
 * of the approved paths, all server-side:
 *   1. Insert into a `demo_requests` table via the Supabase service-role client
 *      (server-only key, never exposed to the browser), and/or
 *   2. Send a transactional notification via the approved email provider.
 * Also add production spam protection (e.g. rate limiting per IP and a captcha
 * service) — the honeypot alone is not sufficient for a public endpoint.
 */
export async function submitDemoRequest(
  input: DemoRequestInput,
): Promise<DemoRequestResult> {
  // Honeypot tripped: pretend it worked, store nothing.
  if (typeof input.website === "string" && input.website.trim() !== "") {
    return { ok: true };
  }

  const errors = validateDemoRequest(input);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  // --- BEGIN development-safe handling (replace for production) -------------
  // Minimise and redact: log only what the discovery team needs to follow up.
  console.info("[demo-request] New submission (dev placeholder, not persisted)", {
    institutionName: input.institutionName.trim(),
    contactPerson: input.contactPerson.trim(),
    role: input.role,
    institutionType: input.institutionType,
    studentCount: input.studentCount,
    email: input.email.trim() || "(none)",
    phone: input.phone.trim() ? "(provided)" : "(none)",
    submittedAt: new Date().toISOString(),
  });
  // --- END development-safe handling ---------------------------------------

  return { ok: true };
}
