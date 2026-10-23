/**
 * Institution applications tests — the pending-approval contract.
 *
 * Pure modules only (lib/institution-applications.ts + the audit catalog),
 * same Node built-in runner as the rest of the suite — no Supabase, no Next.
 * These pin the rules the review queue, the applicant dashboard, and the
 * server actions depend on:
 *   - the application-status vocabulary (0019: draft + on_hold included) and
 *     the OPEN/terminal split, and the queue view that hides drafts,
 *   - the fail-closed decision policy (only legal transitions are allowed;
 *     drafts offer nothing, approved/rejected are terminal),
 *   - a required note for reject / request-information / put-on-hold,
 *   - submission, DRAFT, and RESPONSE validation mirroring the 0016/0019
 *     CHECK bounds (never defaulted),
 *   - untrusted searchParams clamped or dropped (never an arbitrary column),
 *   - the decision actions are recognised audit catalog members and are
 *     scoped to one application by a target pair a blank id can't widen.
 *
 * The database half (0016/0019 CHECKs, the one-open-application unique index,
 * RLS deny-by-default) is covered by
 * supabase/tests/institution_applications_readiness.sql,
 * and the SUPER_ADMIN gate guarding the whole area by
 * tests/platform/super-admin-access.test.mts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLICATION_DECISIONS,
  APPLICATION_QUEUE_STATUSES,
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  DECISION_TARGET_STATUS,
  INSTITUTION_TYPES,
  applicationDraftToFormValues,
  availableDecisions,
  canApplyDecision,
  decisionRequiresNote,
  formatApplicationLocation,
  isApplicationDecision,
  isApplicationStatus,
  isOpenApplication,
  normalizeApplicationStatus,
  resolveApplicationQueueQuery,
  toApplicationContainsPattern,
  validateApplicationDraft,
  validateApplicationNote,
  validateApplicationResponse,
  validateApplicationSubmission,
} from "../../lib/institution-applications.ts";
import {
  APPLICATION_AUDIT_TARGET_TYPE,
  applicationActivityFilter,
  buildAuditEntry,
  isPlatformAuditAction,
  platformAuditActionLabel,
} from "../../lib/audit/platform.ts";

function validSubmission(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    institutionName: "Greenfield Tutorial Centre",
    institutionType: "tutorial_centre",
    contactPerson: "Ngozi Okafor",
    contactEmail: "Admin@Greenfield.Edu.NG",
    contactPhone: "+234 803 123 4567",
    country: "Nigeria",
    state: "Lagos",
    city: "Ikeja",
    address: "14 Allen Avenue, Ikeja",
    description: "Evening WAEC/JAMB classes.",
    ...overrides,
  };
}

// --- Status catalog ---------------------------------------------------------

describe("application status vocabulary", () => {
  it("names exactly the six lifecycle states (0019)", () => {
    assert.deepEqual([...APPLICATION_STATUSES], [
      "draft",
      "pending_review",
      "needs_information",
      "on_hold",
      "approved",
      "rejected",
    ]);
  });

  it("splits open (still one row per applicant) from terminal states", () => {
    assert.equal(isOpenApplication("draft"), true);
    assert.equal(isOpenApplication("pending_review"), true);
    assert.equal(isOpenApplication("needs_information"), true);
    assert.equal(isOpenApplication("on_hold"), true);
    assert.equal(isOpenApplication("approved"), false);
    assert.equal(isOpenApplication("rejected"), false);
  });

  it("the reviewer queue hides drafts — an unfinished application is private", () => {
    assert.equal(APPLICATION_QUEUE_STATUSES.includes("draft"), false);
    assert.deepEqual([...APPLICATION_QUEUE_STATUSES], [
      "pending_review",
      "needs_information",
      "on_hold",
      "approved",
      "rejected",
    ]);
  });

  it("normalises case/whitespace and rejects unknown values (no default)", () => {
    assert.equal(normalizeApplicationStatus(" Pending_Review "), "pending_review");
    assert.equal(normalizeApplicationStatus("on_hold"), "on_hold");
    assert.equal(normalizeApplicationStatus("active"), null);
    assert.equal(normalizeApplicationStatus(undefined), null);
    assert.equal(isApplicationStatus("suspended"), false);
  });
});

// --- Decision policy (fail closed) ------------------------------------------

describe("decision transitions", () => {
  it("offers all four decisions from a submitted open state", () => {
    assert.deepEqual(availableDecisions("pending_review"), [
      "request_information",
      "put_on_hold",
      "reject",
      "approve",
    ]);
    assert.deepEqual(availableDecisions("needs_information"), [
      "request_information",
      "put_on_hold",
      "reject",
      "approve",
    ]);
  });

  it("a held review keeps its three exits but cannot be held again", () => {
    assert.deepEqual(availableDecisions("on_hold"), [
      "request_information",
      "reject",
      "approve",
    ]);
    assert.equal(canApplyDecision("on_hold", "put_on_hold"), false);
    assert.equal(canApplyDecision("on_hold", "approve"), true);
  });

  it("a draft is invisible to reviewers — no decision is ever legal on it", () => {
    assert.deepEqual(availableDecisions("draft"), []);
    assert.equal(canApplyDecision("draft", "approve"), false);
    assert.equal(canApplyDecision("draft", "reject"), false);
    assert.equal(canApplyDecision("draft", "request_information"), false);
    assert.equal(canApplyDecision("draft", "put_on_hold"), false);
  });

  it("terminal states offer and allow nothing", () => {
    assert.deepEqual(availableDecisions("approved"), []);
    assert.deepEqual(availableDecisions("rejected"), []);
    assert.equal(canApplyDecision("approved", "approve"), false);
    assert.equal(canApplyDecision("rejected", "reject"), false);
    assert.equal(canApplyDecision("approved", "reject"), false);
    assert.equal(canApplyDecision("approved", "put_on_hold"), false);
  });

  it("maps each decision to exactly one target status", () => {
    assert.equal(DECISION_TARGET_STATUS.approve, "approved");
    assert.equal(DECISION_TARGET_STATUS.reject, "rejected");
    assert.equal(DECISION_TARGET_STATUS.request_information, "needs_information");
    assert.equal(DECISION_TARGET_STATUS.put_on_hold, "on_hold");
  });

  it("requires a written note for reject, request-information, and hold", () => {
    assert.equal(decisionRequiresNote("reject"), true);
    assert.equal(decisionRequiresNote("request_information"), true);
    assert.equal(decisionRequiresNote("put_on_hold"), true);
    assert.equal(decisionRequiresNote("approve"), false);
  });

  it("guards a decision value from an unknown string", () => {
    assert.equal(isApplicationDecision("approve"), true);
    assert.equal(isApplicationDecision("delete"), false);
  });
});

describe("validateApplicationNote", () => {
  it("refuses a blank required note", () => {
    assert.equal(validateApplicationNote("reject", "   ").ok, false);
    assert.equal(validateApplicationNote("put_on_hold", "   ").ok, false);
  });

  it("names the hold reason its own label (never a generic note)", () => {
    const result = validateApplicationNote("put_on_hold", "");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /hold reason/i);
  });

  it("refuses an over-long note", () => {
    const result = validateApplicationNote("reject", "x".repeat(501));
    assert.equal(result.ok, false);
  });

  it("trims and accepts a valid note", () => {
    const result = validateApplicationNote("reject", "  incomplete docs  ");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, "incomplete docs");
  });
});

// --- Submission validation --------------------------------------------------

describe("validateApplicationSubmission", () => {
  it("accepts a complete submission and normalises email + phone", () => {
    const result = validateApplicationSubmission(validSubmission());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.contactEmail, "admin@greenfield.edu.ng");
      assert.equal(result.value.contactPhone, "+2348031234567");
      assert.equal(result.value.institutionType, "tutorial_centre");
    }
  });

  it("treats an empty description as null, not an empty string", () => {
    const result = validateApplicationSubmission(validSubmission({ description: "  " }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.description, null);
  });

  it("collects required-field errors in one pass", () => {
    const result = validateApplicationSubmission({ institutionName: "", contactPerson: "" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.institutionName);
      assert.ok(result.errors.contactPerson);
      assert.ok(result.errors.contactEmail);
    }
  });

  it("refuses an institution type outside the controlled vocabulary", () => {
    const result = validateApplicationSubmission(
      validSubmission({ institutionType: "university" }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.institutionType);
  });

  it("refuses a malformed email and a non-numeric phone", () => {
    const badEmail = validateApplicationSubmission(validSubmission({ contactEmail: "nope" }));
    assert.equal(badEmail.ok, false);
    const badPhone = validateApplicationSubmission(validSubmission({ contactPhone: "+234abc" }));
    assert.equal(badPhone.ok, false);
  });
});

// --- Draft save validation (pre-submission, 0019) ----------------------------

describe("validateApplicationDraft", () => {
  it("accepts a name-only draft and nulls the absent fields", () => {
    const result = validateApplicationDraft({ institutionName: "Ridge CBT Hub" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.institutionName, "Ridge CBT Hub");
      assert.equal(result.value.institutionType, null);
      assert.equal(result.value.contactEmail, null);
      assert.equal(result.value.description, null);
    }
  });

  it("refuses a draft without the institution name", () => {
    const result = validateApplicationDraft({ institutionName: "   " });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.institutionName);
  });

  it("a PRESENT field must already satisfy the submission bounds and formats", () => {
    const badEmail = validateApplicationDraft({
      institutionName: "Ridge CBT Hub",
      contactEmail: "nope",
    });
    assert.equal(badEmail.ok, false);
    const badPhone = validateApplicationDraft({
      institutionName: "Ridge CBT Hub",
      contactPhone: "+234abc",
    });
    assert.equal(badPhone.ok, false);
    const badType = validateApplicationDraft({
      institutionName: "Ridge CBT Hub",
      institutionType: "university",
    });
    assert.equal(badType.ok, false);
    const tooLong = validateApplicationDraft({
      institutionName: "Ridge CBT Hub",
      address: "x".repeat(201),
    });
    assert.equal(tooLong.ok, false);
  });

  it("normalises a present email and phone like submission does", () => {
    const result = validateApplicationDraft({
      institutionName: "Ridge CBT Hub",
      contactEmail: "Hub@Ridge.NG",
      contactPhone: "+234 803 123 4567",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.contactEmail, "hub@ridge.ng");
      assert.equal(result.value.contactPhone, "+2348031234567");
    }
  });
});

describe("applicationDraftToFormValues", () => {
  it("maps nulls to blanks so a resumed form never shows 'null'", () => {
    const result = validateApplicationDraft({ institutionName: "Ridge CBT Hub" });
    assert.equal(result.ok, true);
    if (result.ok) {
      const values = applicationDraftToFormValues(result.value);
      assert.equal(values.contactPerson, "");
      assert.equal(values.institutionType, "");
      assert.equal(values.institutionName, "Ridge CBT Hub");
    }
  });
});

// --- Applicant response to a needs_information request (0019) ---------------

describe("validateApplicationResponse", () => {
  it("accepts a full submission plus a trimmed response note", () => {
    const result = validateApplicationResponse({
      ...validSubmission(),
      responseNote: "  Registration number RC-109924 attached in the text.  ",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.responseNote, "Registration number RC-109924 attached in the text.");
      assert.equal(result.value.contactEmail, "admin@greenfield.edu.ng");
    }
  });

  it("requires the response note — a bare resubmission is not an answer", () => {
    const result = validateApplicationResponse({ ...validSubmission(), responseNote: "" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.responseNote);
  });

  it("bounds the note at 1000 characters", () => {
    const result = validateApplicationResponse({
      ...validSubmission(),
      responseNote: "x".repeat(1001),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.responseNote);
  });

  it("re-validates EVERY application field (details may be corrected)", () => {
    const result = validateApplicationResponse({
      ...validSubmission({ contactEmail: "nope" }),
      responseNote: "Here is the corrected contact.",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.contactEmail);
      assert.equal(result.values.responseNote, "Here is the corrected contact.");
    }
  });
});

// --- Queue query resolution -------------------------------------------------

describe("resolveApplicationQueueQuery", () => {
  it("drops unknown status / type / range rather than trusting them", () => {
    const query = resolveApplicationQueueQuery({
      status: "active",
      type: "university",
      range: "9999",
    });
    assert.equal(query.status, null);
    assert.equal(query.type, null);
    assert.equal(query.withinDays, null); // unknown range → all time
  });

  it("accepts a valid status / type / range and clamps the page", () => {
    const query = resolveApplicationQueueQuery({
      status: "pending_review",
      type: "school",
      range: "30",
      page: "3",
    });
    assert.equal(query.status, "pending_review");
    assert.equal(query.type, "school");
    assert.equal(query.withinDays, 30);
    assert.equal(query.page, 3);
  });

  it("coerces a missing or non-positive page to the first page", () => {
    assert.equal(resolveApplicationQueueQuery({ page: "0" }).page, 1);
    assert.equal(resolveApplicationQueueQuery({ page: "abc" }).page, 1);
  });

  it("truncates an over-long search term", () => {
    const query = resolveApplicationQueueQuery({ q: "z".repeat(500) });
    assert.ok(query.q.length <= 120);
  });
});

describe("toApplicationContainsPattern", () => {
  it("wraps a clean term and strips PostgREST metacharacters", () => {
    assert.equal(toApplicationContainsPattern("Green"), "%Green%");
    assert.equal(toApplicationContainsPattern("a*b,c"), "%abc%");
    assert.equal(toApplicationContainsPattern("   "), "");
    assert.equal(toApplicationContainsPattern("*%"), "");
  });
});

describe("formatApplicationLocation", () => {
  it("joins the present parts and never invents a value", () => {
    assert.equal(
      formatApplicationLocation({ city: "Ikeja", state: "Lagos", country: "Nigeria" }),
      "Ikeja, Lagos, Nigeria",
    );
    assert.equal(formatApplicationLocation({ city: "", state: null, country: "Nigeria" }), "Nigeria");
    assert.equal(formatApplicationLocation({}), "—");
  });
});

// --- Audit catalog integration ----------------------------------------------

describe("application decision audit wiring", () => {
  it("recognises the four decision actions and labels them", () => {
    for (const action of [
      "institution_application.approved",
      "institution_application.rejected",
      "institution_application.info_requested",
      "institution_application.placed_on_hold",
    ]) {
      assert.equal(isPlatformAuditAction(action), true);
      assert.notEqual(platformAuditActionLabel(action), action);
    }
  });

  it("normalises an approval entry with the application as its target", () => {
    const entry = buildAuditEntry({
      actorId: "user_abc",
      actorRole: "SUPER_ADMIN",
      action: "institution_application.approved",
      targetType: APPLICATION_AUDIT_TARGET_TYPE,
      targetId: "app-1",
      outcome: "success",
      detail: "→ Approved",
    });
    assert.ok(entry);
    assert.equal(entry?.target_type, "institution_application");
    assert.equal(entry?.target_id, "app-1");
  });

  it("scopes decision history to one id and refuses a blank (never all-log)", () => {
    assert.equal(applicationActivityFilter("", 10), null);
    assert.equal(applicationActivityFilter(undefined, 10), null);
    const filter = applicationActivityFilter(" app-1 ", 10);
    assert.equal(filter?.target_type, "institution_application");
    assert.equal(filter?.target_id, "app-1");
  });

  it("keeps the controlled type vocabulary shared with the directory", () => {
    assert.deepEqual([...INSTITUTION_TYPES], ["school", "tutorial_centre", "cbt_centre"]);
  });

  it("every declared decision is a valid catalog member", () => {
    for (const decision of APPLICATION_DECISIONS) {
      assert.ok(Object.keys(DECISION_TARGET_STATUS).includes(decision));
    }
    assert.ok(Object.keys(APPLICATION_STATUS_LABELS).length === APPLICATION_STATUSES.length);
  });
});
