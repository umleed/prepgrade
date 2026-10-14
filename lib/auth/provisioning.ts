/**
 * SERVER-ONLY Clerk Backend-API provisioning for teacher access (prompt 12).
 *
 * WHY THIS EXISTS
 * Today the trusted role lives in Clerk `privateMetadata` (see
 * `lib/auth/context.ts` and `lib/auth/principal.ts`): the browser cannot write
 * that channel, only the Backend API with the secret key can. So "invitation
 * and membership creation occur through trusted server-side logic" concretely
 * means: an authorized institution-admin action calls THESE functions, which
 * are the only place in the app that writes a role into `privateMetadata`.
 *
 * PRIVILEGE-ESCALATION GUARD
 * `grantTeacherRole` hard-codes `role: "TEACHER"`. There is deliberately no
 * parameter that accepts a role, so an admin (or a tampered request) cannot
 * plant SUPER_ADMIN or INSTITUTION_ADMIN through this path. Before granting,
 * an existing trusted role is checked: any role other than TEACHER (or the
 * teacher's own institution) aborts the grant instead of overwriting it, so a
 * platform admin or another tenant's member can never be re-tagged.
 *
 * SWAP PATH: when auth reads `institution_memberships` from the database
 * instead of `privateMetadata`, the metadata writes here become redundant and
 * this module shrinks to invitations + user lookup. Call sites keep the same
 * functions either way.
 */

import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { PRINCIPAL_INSTITUTION_KEY, PRINCIPAL_ROLE_KEY } from "./principal.ts";

/** Thrown when CLERK_SECRET_KEY is absent — callers render an honest state. */
export class ProvisioningUnavailableError extends Error {
  constructor() {
    super(
      "Clerk Backend API is not configured. Set CLERK_SECRET_KEY to invite or activate teachers.",
    );
    this.name = "ProvisioningUnavailableError";
  }
}

/** A minimal, resolved Clerk account — enough to link a roster row to. */
export type ProvisioningUser = {
  userId: string;
  primaryEmail: string | null;
};

/** The trusted role/tenant currently written on an account, if any. */
export type ExistingGrant = {
  role: string | null;
  institutionId: string | null;
};

/** The teacher role written into privateMetadata. Constant by design. */
const TEACHER_ROLE = "TEACHER" as const;

/** Build a client, or fail with the typed "not configured" error. */
async function api() {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new ProvisioningUnavailableError();
  }
  return clerkClient();
}

/** Read the trusted metadata fields this module cares about, defensively. */
function readGrant(privateMetadata: Record<string, unknown> | null | undefined): ExistingGrant {
  const role = privateMetadata?.[PRINCIPAL_ROLE_KEY];
  const institutionId = privateMetadata?.[PRINCIPAL_INSTITUTION_KEY];
  return {
    role: typeof role === "string" && role.trim() ? role.trim() : null,
    institutionId:
      typeof institutionId === "string" && institutionId.trim()
        ? institutionId.trim()
        : null,
  };
}

/**
 * Find the account whose PRIMARY email matches `email` (case-insensitive), or
 * `null` when no account exists yet. Uses the BAPI's email filter and then
 * re-checks the match on the returned record, so a partial-match result can
 * never link the wrong account.
 */
export async function findUserByEmail(email: string): Promise<ProvisioningUser | null> {
  const client = await api();
  const needle = email.trim().toLowerCase();
  if (!needle) return null;

  const { data } = await client.users.getUserList({ emailAddress: [needle], limit: 10 });
  for (const user of data ?? []) {
    const primary = user.primaryEmailAddress?.emailAddress?.toLowerCase();
    if (primary === needle) {
      return { userId: user.id, primaryEmail: user.primaryEmailAddress?.emailAddress ?? null };
    }
  }
  return null;
}

/**
 * Send Clerk's built-in invitation email to an address that has no account
 * yet. Returns true when the invitation was created, false when Clerk refused
 * because the email is already invited or registered (the caller then falls
 * back to linking/activating the existing account). Any OTHER failure throws
 * so the UI can report that the invite email was not sent.
 */
export async function sendTeacherInvitationEmail(email: string): Promise<boolean> {
  const client = await api();
  const redirectUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/login`
    : undefined;

  try {
    await client.invitations.createInvitation({
      emailAddress: email.trim(),
      notify: true,
      redirectUrl,
    });
    return true;
  } catch (error) {
    // Clerk rejects duplicates for invited/registered addresses; that is an
    // expected branch (pending invitation elsewhere), not a crash.
    const status = (error as { status?: number })?.status;
    const message = (error as { errorsText?: () => string })?.errorsText?.() ?? "";
    if (status === 422 && /already|exists/i.test(message)) return false;
    throw error;
  }
}

/**
 * Write the trusted TEACHER role + tenant into the account's privateMetadata.
 * `replaceUserMetadata` is used (not the deep-merging update) so revoke and
 * grant are exact inverses and no stale keys survive either direction.
 *
 * Aborts WITHOUT writing when the account already carries a role that is not
 * TEACHER, or a TEACHER role bound to a different institution — an admin may
 * not re-tag platform/other-tenant accounts (prompt 12's escalation guard).
 * Returns the resulting grant so callers can record what was written.
 */
export async function grantTeacherRole(
  userId: string,
  institutionId: string,
): Promise<ExistingGrant> {
  const client = await api();
  const user = await client.users.getUser(userId);
  const existing = readGrant(user.privateMetadata as Record<string, unknown> | null);

  if (existing.role !== null && existing.role !== TEACHER_ROLE) {
    throw new Error(
      `Account already holds the ${existing.role} role; teacher grants never overwrite an existing role.`,
    );
  }
  if (existing.role === TEACHER_ROLE && existing.institutionId !== institutionId) {
    throw new Error(
      "Account is already a teacher for a different institution; remove that membership first.",
    );
  }

  const restPrivate = {
    ...((user.privateMetadata ?? {}) as Record<string, unknown>),
  };
  delete restPrivate[PRINCIPAL_ROLE_KEY];
  delete restPrivate[PRINCIPAL_INSTITUTION_KEY];

  await client.users.replaceUserMetadata(userId, {
    publicMetadata: (user.publicMetadata ?? {}) as Record<string, unknown>,
    privateMetadata: {
      ...restPrivate,
      [PRINCIPAL_ROLE_KEY]: TEACHER_ROLE,
      [PRINCIPAL_INSTITUTION_KEY]: institutionId,
    },
    unsafeMetadata: (user.unsafeMetadata ?? {}) as Record<string, unknown>,
  });

  return { role: TEACHER_ROLE, institutionId };
}

/**
 * Revoke teacher access: strip role/institutionId from privateMetadata while
 * preserving every other metadata key. A no-op-safe call — an account with no
 * role stays as-is. Refuses to touch an account whose role is not TEACHER, so
 * deactivating a teacher can never clobber an admin's metadata.
 */
export async function revokeTeacherRole(userId: string): Promise<void> {
  const client = await api();
  const user = await client.users.getUser(userId);
  const existing = readGrant(user.privateMetadata as Record<string, unknown>);

  if (existing.role !== null && existing.role !== TEACHER_ROLE) return;

  const restPrivate = {
    ...((user.privateMetadata ?? {}) as Record<string, unknown>),
  };
  delete restPrivate[PRINCIPAL_ROLE_KEY];
  delete restPrivate[PRINCIPAL_INSTITUTION_KEY];

  await client.users.replaceUserMetadata(userId, {
    publicMetadata: (user.publicMetadata ?? {}) as Record<string, unknown>,
    privateMetadata: restPrivate,
    unsafeMetadata: (user.unsafeMetadata ?? {}) as Record<string, unknown>,
  });
}
