/**
 * SERVER-ONLY: reads the current Clerk user record to resolve the sign-up
 * intent. Never import this from a client component.
 *
 * WHY THE INTENT LIVES IN `unsafeMetadata`
 * `lib/auth/registration.ts` explains the trust model. In short: the intent is
 * a user-declared starting point (Student, Teacher, CBT Centre, or School) and
 * nothing else. It is deliberately stored on the *browser-writable* channel
 * because the browser is the only party that ever needs to declare it, and the
 * browser must not be able to write it to `privateMetadata` (which is
 * reserved for the trusted server-side role/membership written by prompts
 * 08/31). Storing the intent on `unsafeMetadata` is safe precisely because
 * nothing in `principal.ts`, `access.ts`, or `guards.ts` ever reads it.
 *
 * FAIL-CLOSED CONTRACT
 * Anything that does not normalise to one of the four declared intents returns
 * `null`. A hostile client that writes `registrationIntent: "SUPER_ADMIN"` (or
 * any other value) into `unsafeMetadata` is treated as "no intent chosen" and
 * sees the picker again — no code path turns that string into a role, a
 * membership, or a workspace link.
 *
 * SWAP PATH (prompt 08)
 * When the tenant schema lands, this helper becomes a `profiles.account_type`
 * read (RLS-scoped to the caller's own row) and the value moves out of Clerk
 * entirely. Call sites keep the same shape — an untrusted, presentation-only
 * `RegistrationIntent | null`.
 */

import { currentUser } from "@clerk/nextjs/server";
import {
  REGISTRATION_INTENT_METADATA_KEY,
  normalizeRegistrationIntent,
  type RegistrationIntent,
} from "./registration.ts";

/**
 * Resolve the current account's declared intent, or `null` when the account
 * has not chosen one (a brand-new Google OAuth sign-up, or a value the
 * normaliser refused). Presentation-only — never authorizes anything.
 */
export async function getRegistrationIntent(): Promise<RegistrationIntent | null> {
  const user = await currentUser();
  if (!user) return null;

  const metadata =
    user.unsafeMetadata && typeof user.unsafeMetadata === "object"
      ? (user.unsafeMetadata as Record<string, unknown>)
      : null;

  return normalizeRegistrationIntent(
    metadata?.[REGISTRATION_INTENT_METADATA_KEY],
  );
}
