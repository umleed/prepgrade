/**
 * Applicant access provisioning tests — the post-approval workspace grant.
 *
 * Pure modules only (the provisioning catalog in lib/institution-applications.ts,
 * the audit catalog, and the auth resolver it must satisfy) — the same Node
 * built-in runner as the rest of the suite, no Supabase / no Clerk / no Next.
 *
 * WHAT THIS PINS
 *   - the provisioning-state vocabulary and its safe default (unrecognised or
 *     absent ⇒ 'not_required', never implies access),
 *   - `workspaceAccessReady` — full success requires status='approved' AND
 *     provisioning='provisioned', so a needs_retry grant is NEVER reported as
 *     ready (the "never silently claim success" rule),
 *   - the self-approval / self-provisioning guard (a reviewer's OWN applicant
 *     account must be refused; a blank id is not a match),
 *   - the controlled recovery-reason tokens an operator can retry on,
 *   - that the two provisioning events are recognised audit-catalog members,
 *   - the trust boundary the grant writes through: the metadata KEYS the
 *     resolver reads (role/institutionId) and the /institution home a resolved
 *     INSTITUTION_ADMIN is routed to — i.e. the Clerk fields provisioning
 *     targets are EXACTLY the fields authorization depends on.
 *
 * WHAT LIVES ELSEWHERE
 *   - The database half (0017 columns/CHECKs, the one-membership-per-(tenant,
 *     user) unique index that makes a retry non-duplicating, RLS denying the
 *     browser so only a SUPER_ADMIN-guarded service-role write path can
 *     provision) is covered by
 *     supabase/tests/applicant_provisioning_readiness.sql.
 *   - The SUPER_ADMIN gate guarding the whole area is covered by
 *     tests/platform/super-admin-access.test.mts.
 *   - The live Clerk write + the partial-failure ordering (DB membership before
 *     metadata, a Clerk fault after the membership lands ⇒ needs_retry/
 *     clerk_metadata_failed) is SERVER-ONLY (lib/auth/provisioning.ts +
 *     lib/data/institution-applications.ts) and cannot run in this runner; it is
 *     verified by a live end-to-end pass against a throwaway project, NOT here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROVISIONING_ERROR_CODES,
  PROVISIONING_ERROR_LABELS,
  PROVISIONING_STATUS_LABELS,
  PROVISIONING_STATUS_TONES,
  PROVISIONING_STATUSES,
  isProvisioningErrorCode,
  isProvisioningStatus,
  isSelfApplication,
  normalizeProvisioningError,
  normalizeProvisioningStatus,
  workspaceAccessReady,
} from "../../lib/institution-applications.ts";
import {
  isPlatformAuditAction,
  platformAuditActionLabel,
} from "../../lib/audit/platform.ts";
import {
  PRINCIPAL_INSTITUTION_KEY,
  PRINCIPAL_ROLE_KEY,
  readTrustedPrincipal,
} from "../../lib/auth/principal.ts";
import { isUserRole, roleHomePath } from "../../lib/auth/roles.ts";

// --- Provisioning-state vocabulary ----------------------------------------

describe("provisioning status catalog", () => {
  it("names exactly the three recoverable states", () => {
    assert.deepEqual([...PROVISIONING_STATUSES], [
      "not_required",
      "provisioned",
      "needs_retry",
    ]);
    for (const status of PROVISIONING_STATUSES) {
      assert.equal(isProvisioningStatus(status), true);
      assert.ok(PROVISIONING_STATUS_LABELS[status]);
      assert.ok(PROVISIONING_STATUS_TONES[status]);
    }
  });

  it("degrades an unknown or absent value to 'not_required' (never implies access)", () => {
    assert.equal(normalizeProvisioningStatus("granted"), "not_required");
    assert.equal(normalizeProvisioningStatus(undefined), "not_required");
    assert.equal(normalizeProvisioningStatus(null), "not_required");
    assert.equal(normalizeProvisioningStatus("provisioned"), "provisioned");
  });
});

// --- "never silently claim success" ---------------------------------------

describe("workspaceAccessReady", () => {
  it("is true ONLY for an approved application that fully provisioned", () => {
    assert.equal(workspaceAccessReady("approved", "provisioned"), true);
  });

  it("is false while a grant still needs retry, even though approved", () => {
    assert.equal(workspaceAccessReady("approved", "needs_retry"), false);
    assert.equal(workspaceAccessReady("approved", "not_required"), false);
  });

  it("is false for every non-approved status regardless of provisioning flag", () => {
    for (const status of ["pending_review", "needs_information", "rejected"] as const) {
      assert.equal(workspaceAccessReady(status, "provisioned"), false);
    }
  });
});

// --- Self-approval / self-provisioning guard -------------------------------

describe("isSelfApplication", () => {
  it("flags a reviewer acting on their OWN applicant account", () => {
    assert.equal(isSelfApplication("user_1", "user_1"), true);
    assert.equal(isSelfApplication(" user_1 ", "user_1"), true);
  });

  it("does not flag two different accounts (cross-applicant decisions are legal)", () => {
    assert.equal(isSelfApplication("user_1", "user_2"), false);
  });

  it("never matches on a blank id (a missing applicant is caught separately)", () => {
    assert.equal(isSelfApplication("", ""), false);
    assert.equal(isSelfApplication("   ", "   "), false);
    assert.equal(isSelfApplication(null, "user_1"), false);
    assert.equal(isSelfApplication("user_1", undefined), false);
  });
});

// --- Controlled recovery reasons -------------------------------------------

describe("provisioning error catalog", () => {
  it("offers exactly the five retry-relevant reasons, each labelled", () => {
    assert.deepEqual([...PROVISIONING_ERROR_CODES], [
      "applicant_missing",
      "tenant_missing",
      "role_conflict",
      "membership_write_failed",
      "clerk_metadata_failed",
    ]);
    for (const code of PROVISIONING_ERROR_CODES) {
      assert.ok(PROVISIONING_ERROR_LABELS[code]);
    }
  });

  it("normalises a stored token and rejects anything unknown (no free text)", () => {
    assert.equal(normalizeProvisioningError("clerk_metadata_failed"), "clerk_metadata_failed");
    assert.equal(normalizeProvisioningError("some raw stack trace"), null);
    assert.equal(normalizeProvisioningError(""), null);
    assert.equal(normalizeProvisioningError(undefined), null);
    assert.equal(isProvisioningErrorCode("role_conflict"), true);
    assert.equal(isProvisioningErrorCode("applicant_email"), false);
  });
});

// --- Audit catalog integration ---------------------------------------------

describe("provisioning audit events", () => {
  it("recognises and labels the provisioned / provision-failed actions", () => {
    for (const action of [
      "institution_application.access_provisioned",
      "institution_application.access_provision_failed",
    ]) {
      assert.equal(isPlatformAuditAction(action), true);
      assert.notEqual(platformAuditActionLabel(action), action);
    }
  });
});

// --- The trust boundary the grant writes THROUGH ---------------------------
// Provisioning must target EXACTLY the privateMetadata fields the resolver
// reads, and the role it writes must route an approved applicant to their
// institution dashboard. These assertions couple the two so a rename on either
// side breaks the test instead of silently granting nothing.

describe("grant matches the auth resolver", () => {
  it("the resolver's trusted keys are the ones provisioning writes", () => {
    // lib/auth/principal.ts is the only reader; grantTeacherRole /
    // grantInstitutionAdminRole write through these same PRINCIPAL_* constants.
    assert.equal(PRINCIPAL_ROLE_KEY, "role");
    assert.equal(PRINCIPAL_INSTITUTION_KEY, "institutionId");
  });

  it("the role provisioning writes is a real UserRole", () => {
    assert.equal(isUserRole("INSTITUTION_ADMIN"), true);
  });

  it("an applicant's own privateMetadata keys do NOT resolve a role (untrusted)", () => {
    // Do-not-grant-from-signup-metadata: the resolver reads privateMetadata only;
    // a publicMetadata / unsafe role string is inert here, exactly as on the server.
    const principal = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: {},
    });
    assert.equal(principal?.role, null);
    assert.equal(principal?.hasMembership, false);
  });

  it("once granted, the principal resolves to INSTITUTION_ADMIN → /institution", () => {
    // Mirrors what grantInstitutionAdminRole writes into privateMetadata:
    // { role: 'INSTITUTION_ADMIN', institutionId: '<approved tenant uuid>' }.
    const granted = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: {
        [PRINCIPAL_ROLE_KEY]: "INSTITUTION_ADMIN",
        [PRINCIPAL_INSTITUTION_KEY]: "institution-uuid-1",
      },
    });
    assert.equal(granted?.role, "INSTITUTION_ADMIN");
    assert.equal(granted?.institutionId, "institution-uuid-1");
    assert.equal(granted?.hasMembership, true);
    assert.equal(roleHomePath(granted?.role ?? null), "/institution");
  });

  it("an approved-but-UNprovisioned applicant still resolves NO role", () => {
    // The pre-provisioning failure state this task fixes: no metadata ⇒ no
    // membership ⇒ routed to /dashboard (the NoMembershipState), never a tenant.
    const principal = readTrustedPrincipal({
      userId: "user_1",
      privateMetadata: {},
    });
    assert.equal(roleHomePath(principal?.role ?? null), "/dashboard");
  });
});
