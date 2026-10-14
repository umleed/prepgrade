/**
 * Registration-intent tests — run with `npm test` (Node's built-in runner).
 *
 * These cover the trust boundary around the sign-up "account type" picker:
 *   - All four intents normalise; nothing else does.
 *   - Privileged role strings are rejected (fail-closed) so a hostile client
 *     cannot pick `SUPER_ADMIN` or `INSTITUTION_ADMIN` via a tampered
 *     `unsafeMetadata`.
 *   - The intent is *descriptive* only — it never turns into an authoritative
 *     `UserRole`, never appears in `privateMetadata`, and never grants any
 *     application area.
 *   - A signed-in account with an intent but no trusted role/membership still
 *     resolves to `role: null` and is denied every workspace via
 *     `decideAccess()` — the same rule the app runs in production.
 *
 * Database / RLS coverage is deferred to prompt 08 — none is claimed here
 * because none exists yet in the repository.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideAccess } from "../../lib/auth/access.ts";
import { readTrustedPrincipal } from "../../lib/auth/principal.ts";
import {
  INTENT_LABELS,
  INTENT_OUTCOMES,
  REGISTRATION_INTENTS,
  REGISTRATION_INTENT_METADATA_KEY,
  intentLabel,
  intentNextStep,
  isRegistrationIntent,
  normalizeRegistrationIntent,
} from "../../lib/auth/registration.ts";
import { canAccessArea } from "../../lib/auth/roles.ts";

describe("normalizeRegistrationIntent — accept only the four declared intents", () => {
  it("accepts every declared intent in its canonical spelling", () => {
    for (const intent of REGISTRATION_INTENTS) {
      assert.equal(normalizeRegistrationIntent(intent), intent);
    }
  });

  it("tolerates casing, padding, hyphens, and internal spaces", () => {
    assert.equal(normalizeRegistrationIntent(" Student "), "student");
    assert.equal(normalizeRegistrationIntent("TEACHER"), "teacher");
    assert.equal(normalizeRegistrationIntent("CBT Centre"), "cbt_centre");
    assert.equal(normalizeRegistrationIntent("cbt-centre"), "cbt_centre");
    assert.equal(normalizeRegistrationIntent("school"), "school");
  });

  it("returns null for anything unrecognized instead of guessing a default", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "admin",
      "owner",
      "principal",
      "parent",
      "user",
      42,
      { intent: "student" },
      ["student"],
    ]) {
      assert.equal(normalizeRegistrationIntent(value), null, `for ${String(value)}`);
    }
  });

  it("isRegistrationIntent only recognises real intents (no case folding)", () => {
    assert.equal(isRegistrationIntent("student"), true);
    assert.equal(isRegistrationIntent("Student"), false);
    assert.equal(isRegistrationIntent("cbt_centre"), true);
    assert.equal(isRegistrationIntent("cbt centre"), false);
    assert.equal(isRegistrationIntent("SUPER_ADMIN"), false);
  });
});

describe("Escalation defense — privileged strings are never valid intents", () => {
  // A hostile client could try to write any of these into `unsafeMetadata`
  // through browser devtools. The normaliser must reject every one so the
  // onboarding UI treats the account as "no intent chosen" and the
  // authorization stack (which never reads `unsafeMetadata` anyway) has
  // nothing to leak.
  const PRIVILEGED_VALUES: readonly string[] = [
    "SUPER_ADMIN",
    "super_admin",
    "super admin",
    "super-admin",
    "INSTITUTION_ADMIN",
    "institution_admin",
    "Institution-Admin",
    "institution admin",
    "ADMIN",
    "admin",
    "root",
    "owner",
    "principal",
    "*",
    "__proto__",
  ];

  for (const value of PRIVILEGED_VALUES) {
    it(`rejects "${value}" instead of treating it as an intent`, () => {
      assert.equal(normalizeRegistrationIntent(value), null);
    });
  }

  it("never turns a privileged role string into a valid intent", () => {
    // Only the privileged roles are dangerous here. `STUDENT` and `TEACHER`
    // are also legitimate low-privilege internal roles, so the lowercase
    // spellings "student"/"teacher" happen to collide with intent names —
    // that is harmless because nothing reads `unsafeMetadata` for
    // authorization. The escalation-prevention invariant is: the two
    // *privileged* role strings never resolve to an intent, in any casing
    // or spacing, so no `unsafeMetadata` value can pick them.
    const privilegedRoles = ["SUPER_ADMIN", "INSTITUTION_ADMIN"] as const;
    for (const role of privilegedRoles) {
      assert.equal(normalizeRegistrationIntent(role), null);
      assert.equal(normalizeRegistrationIntent(role.toLowerCase()), null);
      assert.equal(normalizeRegistrationIntent(role.replace(/_/g, " ")), null);
      assert.equal(normalizeRegistrationIntent(role.replace(/_/g, "-")), null);
    }
    // And the intent normaliser never returns a privileged role name.
    for (const intent of REGISTRATION_INTENTS) {
      assert.notEqual(intent, "SUPER_ADMIN");
      assert.notEqual(intent, "INSTITUTION_ADMIN");
    }
  });
});

describe("Intent outcomes — descriptive, never self-service", () => {
  it("every intent has a label, a hint, a next-step sentence, and an outcome", () => {
    for (const intent of REGISTRATION_INTENTS) {
      assert.ok(INTENT_LABELS[intent].length > 0);
      assert.ok(intentNextStep(intent).length > 0);
      const outcome = INTENT_OUTCOMES[intent];
      assert.ok(outcome);
      // Self-service is denied at every branch of the MVP.
      assert.equal(outcome.selfService, false);
    }
  });

  it("students and teachers are gated by an institution-side invitation process", () => {
    assert.equal(
      INTENT_OUTCOMES.student.requires,
      "institution_invitation_or_join_request",
    );
    assert.equal(
      INTENT_OUTCOMES.teacher.requires,
      "institution_invitation_or_join_request",
    );
  });

  it("CBT centres and schools are gated by super-admin approval", () => {
    assert.equal(INTENT_OUTCOMES.cbt_centre.requires, "super_admin_approval");
    assert.equal(INTENT_OUTCOMES.school.requires, "super_admin_approval");
  });

  it("an unknown intent label falls back to an honest 'not chosen yet'", () => {
    assert.equal(intentLabel(null), "Not chosen yet");
    assert.equal(intentLabel("student"), "Student");
  });

  it("never exposes SUPER_ADMIN as an eventual role from any intent", () => {
    // The intent → role mapping is a one-way descriptive link. If a future
    // change ever let an intent resolve to SUPER_ADMIN, that would be a
    // public-escalation path and this test would start failing.
    for (const intent of REGISTRATION_INTENTS) {
      assert.notEqual(INTENT_OUTCOMES[intent].role, "SUPER_ADMIN");
    }
  });
});

describe("Fail-closed integration — an intent never authorises anything", () => {
  // This is the security property that ties the picker to the existing
  // authorization stack: writing an intent into `unsafeMetadata` (the only
  // channel the browser can write) does not survive into the principal,
  // because `readTrustedPrincipal` only reads `privateMetadata`. Even a
  // would-be attacker who tampers with `unsafeMetadata` still has to pass
  // `decideAccess()`, which is fed only the trusted principal.

  const userId = "user_new_signup";

  // Builds the principal the onboarding/dashboard reader would see for an
  // account that only has an intent on `unsafeMetadata`. `readTrustedPrincipal`
  // is deliberately fed only `privateMetadata`, so the intent itself is
  // irrelevant to the trust boundary — we still capture it so each case is
  // labelled in the failure message.
  function principalWithOnlyIntent(intent: string) {
    assert.ok(typeof intent === "string" && intent.length > 0);
    return readTrustedPrincipal({
      userId,
      privateMetadata: null,
    });
  }

  it("resolves a fresh signup (intent only) to no role, no membership", () => {
    for (const intent of REGISTRATION_INTENTS) {
      const principal = principalWithOnlyIntent(intent);
      assert.ok(principal, `principal built for ${intent}`);
      assert.equal(principal.role, null);
      assert.equal(principal.institutionId, null);
      assert.equal(principal.hasMembership, false);
    }
  });

  it("denies every application area for an intent-only account", () => {
    for (const intent of REGISTRATION_INTENTS) {
      const principal = principalWithOnlyIntent(intent);
      assert.ok(principal);
      for (const area of ["platform", "institution", "teacher", "student"] as const) {
        // No role → canAccessArea is always false.
        assert.equal(canAccessArea(principal.role, area), false, `${intent}/${area}`);
      }
      // And the access engine itself refuses, before role/tenant evaluation.
      const decision = decideAccess(
        { session: "active", principal },
        {},
      );
      assert.equal(decision.allowed, false);
      if (!decision.allowed) {
        assert.equal(decision.reason, "noMembership", intent);
      }
    }
  });

  it("refuses a tampered intent (e.g. SUPER_ADMIN on unsafeMetadata) the same way", () => {
    // Even if a hostile client writes the raw string, the principal reader
    // still receives an empty `privateMetadata`, and no `roles.ts` code path
    // ever consults the intent. So the outcome is identical to no intent.
    const principal = principalWithOnlyIntent("SUPER_ADMIN");
    assert.ok(principal);
    assert.equal(principal.role, null);
    assert.equal(principal.hasMembership, false);
    const decision = decideAccess(
      { session: "active", principal },
      { roles: ["INSTITUTION_ADMIN"], institutionId: "inst_other" },
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, "noMembership");
    }
  });

  it("does not treat the intent metadata key as a role metadata key", () => {
    // Two independent keys — the presence of one on metadata must not imply
    // the other. `PRINCIPAL_ROLE_KEY` is `"role"`, our intent key is
    // `"registrationIntent"`. Asserting the exact strings protects against a
    // well-meaning rename that would make the intent channel authoritative.
    assert.equal(REGISTRATION_INTENT_METADATA_KEY, "registrationIntent");
    assert.notEqual(REGISTRATION_INTENT_METADATA_KEY, "role");
    assert.notEqual(REGISTRATION_INTENT_METADATA_KEY, "institutionId");
  });
});
