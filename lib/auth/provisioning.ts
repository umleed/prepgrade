/**
 * SERVER-ONLY Clerk Backend-API provisioning for trusted role grants.
 *
 * WHY THIS EXISTS
 * Today the trusted role lives in Clerk `privateMetadata` (see
 * `lib/auth/context.ts` and `lib/auth/principal.ts`): the browser cannot write
 * that channel, only the Backend API with the secret key can. So "invitation
 * and membership creation occur through trusted server-side logic" concretely
 * means: an authorized action calls THESE functions, which are the only place
 * in the app that writes a role into `privateMetadata`.
 *
 * Two grant paths live here:
 *   • TEACHER — an institution admin activates a rostered teacher
 *     (`grantTeacherRole` / `revokeTeacherRole`, prompt 12).
 *   • INSTITUTION_ADMIN — a SUPER_ADMIN provisioning an APPROVED applicant into
 *     their new tenant (`getProvisioningAccount` / `grantInstitutionAdminRole`,
 *     the applicant-access step built on migrations 0016/0017).
 *
 * PRIVILEGE-ESCALATION GUARD
 * Each grant hard-codes its role constant (`TEACHER` / `INSTITUTION_ADMIN`).
 * There is deliberately no parameter that accepts a role, so a caller (or a
 * tampered request) can never plant SUPER_ADMIN through this path. Before
 * granting, the existing trusted role is checked: any role other than the one
 * being granted (or the same role bound to a different institution) ABORTS the
 * grant instead of overwriting it, so a platform admin or another tenant's
 * member can never be re-tagged.
 *
 * SWAP PATH: when auth reads `institution_memberships` from the database
 * instead of `privateMetadata`, the metadata writes here become redundant and
 * this module shrinks to invitations + user lookup. Call sites keep the same
 * functions either way.
 */

import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { invitationRedirectUrl, isDuplicateInvitationError } from "../notifications.ts";
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

/** A resolved provisioning account plus its current trusted grant and the
 *  identity fields needed to mirror it into `profiles`. Read-only snapshot used
 *  BEFORE any write so a role conflict or a missing account is detected without
 *  leaving a stray membership behind. */
export type ProvisioningAccount = {
  userId: string;
  email: string | null;
  fullName: string | null;
  role: string | null;
  institutionId: string | null;
};

/** The teacher role written into privateMetadata. Constant by design. */
const TEACHER_ROLE = "TEACHER" as const;

/** The institution-admin role written for a provisioned applicant. Constant by
 *  design — like TEACHER_ROLE, no caller can pass a role, so this path can
 *  never mint SUPER_ADMIN. Mirrors ROLE_HOME_PATH.INSTITUTION_ADMIN = /institution. */
const INSTITUTION_ADMIN_ROLE = "INSTITUTION_ADMIN" as const;

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
  // Pure helpers (lib/notifications.ts) hold the redirect shape and the
  // duplicate-vs-fatal classification so they are unit-tested without Clerk.
  const redirectUrl = invitationRedirectUrl(process.env.NEXT_PUBLIC_APP_URL);

  try {
    await client.invitations.createInvitation({
      emailAddress: email.trim(),
      notify: true,
      redirectUrl,
    });
    return true;
  } catch (error) {
    // Clerk rejects duplicates for invited/registered addresses; that is an
    // expected branch (pending invitation elsewhere), not a crash. Any OTHER
    // failure rethrows so the caller reports the invite email was not sent
    // WITHOUT rolling back the roster row (prompt 35: failed delivery must not
    // lose the underlying record).
    if (isDuplicateInvitationError(error)) return false;
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

/**
 * Read-only snapshot of a provisioning account: its current trusted grant plus
 * the identity fields (primary email, full name) the approval flow mirrors into
 * `profiles`. Used BEFORE any database write so a role conflict or a missing
 * account is surfaced as a recoverable `needs_retry` without leaving a stray
 * membership.
 *
 * Returns `null` when no Clerk account resolves for `userId` (e.g. the
 * applicant deleted their account after applying) — the caller records
 * `applicant_missing` and grants nothing. Throws ProvisioningUnavailableError
 * only when the Backend API is unconfigured; a per-user lookup failure is
 * treated as "no account" so the caller degrades to a visible retry state.
 */
export async function getProvisioningAccount(
  userId: string,
): Promise<ProvisioningAccount | null> {
  const client = await api();
  const trimmed = userId.trim();
  if (!trimmed) return null;

  try {
    const user = await client.users.getUser(trimmed);
    const grant = readGrant(user.privateMetadata as Record<string, unknown> | null);
    const fullName =
      typeof user.fullName === "string" && user.fullName.trim()
        ? user.fullName.trim()
        : null;
    return {
      userId: user.id,
      email: user.primaryEmailAddress?.emailAddress ?? null,
      fullName,
      role: grant.role,
      institutionId: grant.institutionId,
    };
  } catch {
    // Any lookup failure (not-found, or a transient BAPI error) is reported as
    // "no resolvable account" so the caller records applicant_missing rather
    // than crashing the approval — a genuinely absent account and an
    // unresolvable one are both retried the same safe way.
    return null;
  }
}

/**
 * Write the trusted INSTITUTION_ADMIN role + tenant into an approved
 * applicant's privateMetadata — the counterpart of `grantTeacherRole` for the
 * first workspace member. Uses `replaceUserMetadata` so every other metadata
 * key is preserved and grant/revoke stay exact inverses.
 *
 * Aborts WITHOUT writing when the account already holds a role that is not
 * INSTITUTION_ADMIN, or an INSTITUTION_ADMIN role bound to a different
 * institution — so approval provisioning can never re-tag a platform admin or
 * a member of another tenant (the escalation guard the applicant-access flow
 * relies on). Returns the resulting grant so callers can record what was
 * written.
 */
export async function grantInstitutionAdminRole(
  userId: string,
  institutionId: string,
): Promise<ExistingGrant> {
  const client = await api();
  const user = await client.users.getUser(userId);
  const existing = readGrant(user.privateMetadata as Record<string, unknown> | null);

  if (existing.role !== null && existing.role !== INSTITUTION_ADMIN_ROLE) {
    throw new Error(
      `Account already holds the ${existing.role} role; approval provisioning never overwrites an existing role.`,
    );
  }
  if (
    existing.role === INSTITUTION_ADMIN_ROLE &&
    existing.institutionId !== institutionId
  ) {
    throw new Error(
      "Account is already an institution administrator for a different institution; resolve that membership first.",
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
      [PRINCIPAL_ROLE_KEY]: INSTITUTION_ADMIN_ROLE,
      [PRINCIPAL_INSTITUTION_KEY]: institutionId,
    },
    unsafeMetadata: (user.unsafeMetadata ?? {}) as Record<string, unknown>,
  });

  return { role: INSTITUTION_ADMIN_ROLE, institutionId };
}
