/**
 * Notification decision logic — prompt 35 (pure, dependency-free, unit-testable).
 *
 * WHY THIS EXISTS AND WHAT IS IN SCOPE
 * The repository's ONLY configured delivery mechanism is Clerk: its Backend API
 * sends the member-invitation email and its auth flow sends the sign-up
 * email-code verification. Those are the transactional messages the MVP needs,
 * and the actual network send is SERVER-ONLY (`lib/auth/provisioning.ts`, which
 * imports `server-only` + Clerk, so it cannot run in the Node test runner — the
 * live delivery is verified end-to-end against a real project, not here).
 *
 * What CAN be tested are the small, pure DECISIONS that shape how that delivery
 * is requested and how its failures are classified. They lived inline in the
 * server-only module; extracting them here follows the repo convention (pure
 * contract module in `lib/`, imported by the server caller) so the prompt's
 * "handle failed delivery without losing the record" requirement is pinned by a
 * test instead of asserted in prose.
 *
 * DELIBERATELY NOT HERE (student-facing alerts)
 * "Exam available" and "results ready" messages are addressed to STUDENTS, but
 * a student record carries NO email (personal data is minimised — AGENTS.md §7,
 * see lib/students.ts) and may have no Clerk account at all (`profile_id` is
 * nullable). There is therefore no configured channel to reach them: an
 * email/SMS provider would be a new dependency needing approval, collecting
 * student emails would reverse the privacy-minimisation decision, and the
 * in-app notification centre is explicitly a separate task. Those notifications
 * are DEFERRED — this module intentionally grows no delivery surface for them.
 *
 * No new packages; nothing here imports `server-only`, Clerk, Supabase or Next.
 */

/**
 * The Clerk Backend-API error shape we care about, structurally. A real Clerk
 * `ApiError` exposes a numeric `status` and an `errorsText()` accessor; we type
 * it loosely so the classifier can be fed hand-built fixtures in the pure test
 * runner and still match the live object exactly.
 */
export type InvitationDeliveryError = {
  status?: number;
  errorsText?: () => string;
};

/**
 * Classify a failed invitation send as an EXPECTED duplicate rather than a
 * delivery crash.
 *
 * Clerk refuses a new invitation with HTTP 422 when the address is ALREADY
 * invited or already registered. That is a normal branch of the flow — the
 * caller records the pending invite and tells the admin to use "Activate
 * access" once the account exists — so it must NOT bubble up as "the email
 * could not be sent". EVERY OTHER failure (network, auth, a 4xx/5xx without
 * the duplicate signal) stays fatal so the admin is told the truth.
 *
 * The test is intentionally conservative: BOTH the 422 status AND a message
 * mentioning an existing/already-invited address must agree before we swallow
 * the error. A 422 for some other validation reason, or a duplicate-looking
 * message under a different status, is NOT treated as a duplicate — fail loud
 * is safer than silently dropping a real delivery failure.
 */
export function isDuplicateInvitationError(
  error: InvitationDeliveryError | unknown,
): boolean {
  const status = (error as InvitationDeliveryError | null)?.status;
  const message = (error as InvitationDeliveryError | null)?.errorsText?.() ?? "";
  return status === 422 && /already|exists/i.test(message);
}

/**
 * Build the redirect URL an invited member lands on after accepting — the
 * application's sign-in page. Kept pure (the caller passes the value read from
 * `NEXT_PUBLIC_APP_URL`) so the trailing-slash handling and the "no base URL
 * configured ⇒ no redirect override" branch are testable without Clerk.
 *
 * This URL is intentionally a bare, shared `/login` path: it carries NO
 * institution id, NO exam/result reference and NO personal data, so the
 * invitation link cannot leak tenant or assessment information (AGENTS.md §7).
 * When no base URL is set we return `undefined` so Clerk applies its own
 * default rather than the app fabricating a broken absolute link.
 */
export function invitationRedirectUrl(
  appUrl: string | null | undefined,
): string | undefined {
  const trimmed = appUrl?.trim();
  if (!trimmed) return undefined;
  return `${trimmed.replace(/\/+$/, "")}/login`;
}
