/**
 * Exam list, detail & builder tests — prompts 17–18, plus the prompt 20
 * student-dashboard bucketing rule.
 *
 * Two classes of coverage, both on pure code the app actually runs:
 *   1. the exam contract in lib/exams.ts — validation bounds mirroring the
 *      0010/0011 CHECKs (including the builder fields: category, attempt
 *      limit, randomisation, result release), the lifecycle transition map,
 *      the publish gate, the derived display states (the ONLY place
 *      "Active"/"Completed" exist), the delivery-field locks that protect
 *      live and historical attempts, the builder edit-safety rules
 *      (`examBuilderEditable`, per-question marks bounds, pre-publish
 *      warnings), and the clamping of untrusted list-filter searchParams.
 *   2. the exam.manage / exam.publish permission + the tenant and
 *      delete-privilege boundary the flows rely on. NOTE ON WHAT THE FLOW
 *      CALLS: the exam pages and server actions authorize with
 *      `requireRole(["TEACHER","INSTITUTION_ADMIN"])` and scope every query by
 *      the trusted `principal.institutionId`; the finer `checkResourceAccess()`
 *      engine (kind "exam") is exercised here as the reference boundary —
 *      including that a TEACHER may manage exams but NEVER delete them
 *      (AGENTS.md §5, §6).
 *
 * The Supabase data layer itself is NOT exercised here — there is no live DB in
 * `npm test`. Its guarantees (status/window/duration CHECKs, the NOT NULL
 * tenant anchor, the question→exam and class→exam anchor triggers, the 0011
 * builder CHECKs and the append-only snapshot grants, cross-tenant id
 * handling, deployed RLS) are covered by the runnable SQL harnesses in
 * supabase/tests/exams_readiness.sql and exam_builder_readiness.sql, which
 * need a real database.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXAM_INPUT_EMPTY,
  EXAM_MAX_ATTEMPTS_MAX,
  EXAM_MAX_ATTEMPTS_MIN,
  EXAM_PAGE_SIZE,
  EXAM_QUESTION_MARKS_MAX,
  EXAM_QUESTION_MARKS_MIN,
  examBuilderEditable,
  examBuilderWarnings,
  examDisplayState,
  examEffectiveStudentCount,
  examFieldEditable,
  examIsAvailableToStudent,
  examLockedFields,
  examPageHref,
  examPublishBlocker,
  examQuestionMarksError,
  examTotalMarks,
  examTransitionOptions,
  canTransitionExam,
  formatDuration,
  isExamResultsRelease,
  isExamStatus,
  normalizeExamInput,
  parseExamDate,
  resolveExamListQuery,
  studentExamBucket,
  studentExamEligibility,
  studentExamStartGate,
  EXAM_START_INTERFACE_UNAVAILABLE_MESSAGE,
  toDatetimeLocalValue,
  validateExam,
  type ExamInput,
} from "../../lib/exams.ts";
import type { AccessSubject } from "../../lib/auth/access.ts";
import { decideAccess } from "../../lib/auth/access.ts";
import type { AuthPrincipal } from "../../lib/auth/principal.ts";
import { readTrustedPrincipal } from "../../lib/auth/principal.ts";
import { hasPermission } from "../../lib/auth/permissions.ts";
import type { UserRole } from "../../lib/auth/roles.ts";
import {
  checkResourceAccess,
  type ResourceAccessRequest,
  type ResourceDescriptor,
} from "../../lib/auth/resource-access.ts";

const INSTITUTION_A = "inst_1111aaaa";
const INSTITUTION_B = "inst_2222bbbb";

/** A structurally valid exam payload; override fields per case. */
function examInput(overrides: Partial<ExamInput> = {}): ExamInput {
  return {
    ...EXAM_INPUT_EMPTY,
    title: "Mid-term Mathematics Mock",
    subjectId: "subj-1",
    durationMinutes: 60,
    ...overrides,
  };
}

// --- Exam validation ----------------------------------------------------------

describe("validateExam", () => {
  it("accepts a well-formed unscheduled exam", () => {
    assert.deepEqual(validateExam(examInput()), {});
  });

  it("accepts a well-formed availability window", () => {
    assert.deepEqual(
      validateExam(
        examInput({
          startsAt: "2026-11-01T09:00",
          endsAt: "2026-11-05T17:00",
        }),
      ),
      {},
    );
  });

  it("requires a title and a subject", () => {
    const errors = validateExam(examInput({ title: "   ", subjectId: "" }));
    assert.ok(errors.title);
    assert.ok(errors.subjectId);
  });

  it("bounds the title length", () => {
    assert.ok(validateExam(examInput({ title: "x".repeat(161) })).title);
    assert.equal(
      validateExam(examInput({ title: "x".repeat(160) })).title,
      undefined,
    );
  });

  it("bounds the description length but allows it empty", () => {
    assert.equal(validateExam(examInput({ description: "" })).description, undefined);
    assert.ok(
      validateExam(examInput({ description: "d".repeat(2001) })).description,
    );
  });

  it("requires a whole duration inside the DB CHECK bounds", () => {
    assert.ok(validateExam(examInput({ durationMinutes: 0 })).durationMinutes);
    assert.ok(validateExam(examInput({ durationMinutes: 481 })).durationMinutes);
    assert.ok(validateExam(examInput({ durationMinutes: 45.5 })).durationMinutes);
    assert.equal(validateExam(examInput({ durationMinutes: 480 })).durationMinutes, undefined);
  });

  it("requires both or neither half of the availability window", () => {
    // a start with no end is not a window students can be graded against
    const missingEnd = validateExam(examInput({ startsAt: "2026-11-01T09:00" }));
    assert.ok(missingEnd.endsAt);
    const missingStart = validateExam(examInput({ endsAt: "2026-11-05T17:00" }));
    assert.ok(missingStart.startsAt);
    // neither set is a legitimate "unscheduled" exam
    assert.deepEqual(
      validateExam(examInput({ startsAt: "", endsAt: "" })),
      {},
    );
  });

  it("refuses a window that ends at or before it starts", () => {
    assert.ok(
      validateExam(
        examInput({ startsAt: "2026-11-05T17:00", endsAt: "2026-11-01T09:00" }),
      ).endsAt,
    );
    assert.ok(
      validateExam(
        examInput({ startsAt: "2026-11-01T09:00", endsAt: "2026-11-01T09:00" }),
      ).endsAt,
    );
  });

  it("reports an unparseable date instead of silently dropping it", () => {
    const errors = validateExam(examInput({ startsAt: "not a date", endsAt: "" }));
    assert.ok(errors.startsAt);
  });

  it("accepts the builder config defaults (one attempt, conservative release)", () => {
    assert.equal(EXAM_INPUT_EMPTY.maxAttempts, 1);
    assert.equal(EXAM_INPUT_EMPTY.resultsRelease, "after_window");
    assert.equal(EXAM_INPUT_EMPTY.shuffleQuestions, false);
    assert.equal(EXAM_INPUT_EMPTY.shuffleOptions, false);
    assert.deepEqual(validateExam(examInput({ categoryId: "cat-1" })), {});
  });

  it("bounds the attempt limit exactly like the 0011 CHECK (1–10)", () => {
    assert.equal(
      validateExam(examInput({ maxAttempts: EXAM_MAX_ATTEMPTS_MIN })).maxAttempts,
      undefined,
    );
    assert.equal(
      validateExam(examInput({ maxAttempts: EXAM_MAX_ATTEMPTS_MAX })).maxAttempts,
      undefined,
    );
    assert.ok(validateExam(examInput({ maxAttempts: 0 })).maxAttempts);
    assert.ok(validateExam(examInput({ maxAttempts: EXAM_MAX_ATTEMPTS_MAX + 1 })).maxAttempts);
    assert.ok(validateExam(examInput({ maxAttempts: 2.5 })).maxAttempts);
  });

  it("refuses a result release outside the schema's vocabulary", () => {
    assert.deepEqual(
      validateExam(examInput({ resultsRelease: "manual" })).resultsRelease,
      undefined,
    );
    assert.ok(
      validateExam(
        examInput({ resultsRelease: "on_submission_then_week" as ExamInput["resultsRelease"] }),
      ).resultsRelease,
    );
    assert.equal(isExamResultsRelease("immediate"), true);
    assert.equal(isExamResultsRelease("after_window"), true);
    assert.equal(isExamResultsRelease("manual"), true);
    assert.equal(isExamResultsRelease("never"), false);
    assert.equal(isExamResultsRelease(null), false);
  });

  it("requires randomisation settings to be real booleans", () => {
    assert.ok(
      validateExam(
        examInput({ shuffleQuestions: "yes" as unknown as boolean }),
      ).shuffleQuestions,
    );
    assert.ok(
      validateExam(
        examInput({ shuffleOptions: 1 as unknown as boolean }),
      ).shuffleQuestions,
    );
  });

  it("keeps the category a plain optional string", () => {
    assert.ok(validateExam(examInput({ categoryId: 5 as unknown as string })).categoryId);
  });
});

describe("parseExamDate", () => {
  it("returns null for unset, NaN for invalid, epoch ms otherwise", () => {
    assert.equal(parseExamDate(""), null);
    assert.equal(parseExamDate("   "), null);
    assert.ok(Number.isNaN(parseExamDate("definitely not a date")));
    const parsed = parseExamDate("2026-11-01T09:00");
    assert.equal(typeof parsed, "number");
    assert.ok(!Number.isNaN(parsed));
  });
});

describe("normalizeExamInput", () => {
  it("trims every text field", () => {
    const normalized = normalizeExamInput(
      examInput({ title: "  Mock exam ", description: "  notes  ", subjectId: " subj-1 " }),
    );
    assert.equal(normalized.title, "Mock exam");
    assert.equal(normalized.description, "notes");
    assert.equal(normalized.subjectId, "subj-1");
  });

  it("carries the builder fields through untouched", () => {
    const normalized = normalizeExamInput(
      examInput({
        categoryId: "  cat-1 ",
        maxAttempts: 3,
        shuffleQuestions: true,
        shuffleOptions: false,
        resultsRelease: "manual",
      }),
    );
    assert.equal(normalized.categoryId, "cat-1");
    assert.equal(normalized.maxAttempts, 3);
    assert.equal(normalized.shuffleQuestions, true);
    assert.equal(normalized.shuffleOptions, false);
    assert.equal(normalized.resultsRelease, "manual");
  });
});

// --- Status model --------------------------------------------------------------

describe("exam status enum", () => {
  it("recognises only the stored lifecycle statuses", () => {
    for (const status of ["draft", "scheduled", "published", "closed", "archived"]) {
      assert.equal(isExamStatus(status), true);
    }
    // the derived display labels are NOT statuses — no second enum can drift in
    assert.equal(isExamStatus("active"), false);
    assert.equal(isExamStatus("completed"), false);
    assert.equal(isExamStatus("retired"), false);
    assert.equal(isExamStatus(null), false);
  });
});

describe("examDisplayState", () => {
  const now = new Date("2026-11-03T12:00:00Z");

  it("reads a live published exam as Active", () => {
    const state = examDisplayState(
      "published",
      "2026-11-01T09:00:00Z",
      "2026-11-05T17:00:00Z",
      now,
    );
    assert.equal(state.label, "Active");
  });

  it("reads a published exam past its window as Completed", () => {
    const state = examDisplayState(
      "published",
      "2026-10-01T09:00:00Z",
      "2026-10-05T17:00:00Z",
      now,
    );
    assert.equal(state.label, "Completed");
  });

  it("reads a published exam before its window as Scheduled", () => {
    const state = examDisplayState(
      "published",
      "2026-12-01T09:00:00Z",
      "2026-12-05T17:00:00Z",
      now,
    );
    assert.equal(state.label, "Scheduled");
  });

  it("treats an open-ended published exam (no end) as Active once started", () => {
    const state = examDisplayState("published", "2026-11-01T09:00:00Z", null, now);
    assert.equal(state.label, "Active");
  });

  it("shows stored statuses untouched by the clock", () => {
    assert.equal(examDisplayState("draft", null, null, now).label, "Draft");
    assert.equal(examDisplayState("closed", "2026-11-01T09:00:00Z", "2026-11-05T17:00:00Z", now).label, "Closed");
    assert.equal(examDisplayState("archived", null, null, now).label, "Archived");
  });
});

// --- Transitions and the publish gate -------------------------------------------

describe("canTransitionExam", () => {
  it("allows the documented lifecycle moves", () => {
    assert.equal(canTransitionExam("draft", "scheduled"), true);
    assert.equal(canTransitionExam("draft", "published"), true);
    assert.equal(canTransitionExam("scheduled", "published"), true);
    assert.equal(canTransitionExam("scheduled", "draft"), true); // the one backward move
    assert.equal(canTransitionExam("published", "closed"), true);
    assert.equal(canTransitionExam("closed", "archived"), true);
    assert.equal(canTransitionExam("draft", "archived"), true);
  });

  it("refuses moves that would rewrite delivery history", () => {
    assert.equal(canTransitionExam("published", "draft"), false);
    assert.equal(canTransitionExam("published", "scheduled"), false);
    assert.equal(canTransitionExam("published", "archived"), false); // close first
    assert.equal(canTransitionExam("archived", "draft"), false);     // terminal
    assert.equal(canTransitionExam("archived", "published"), false);
    assert.equal(canTransitionExam("closed", "published"), false);
  });

  it("lists offered transitions per status (UI derives buttons from this)", () => {
    assert.deepEqual(examTransitionOptions("published"), ["closed"]);
    assert.deepEqual(examTransitionOptions("archived"), []);
  });
});

describe("examPublishBlocker", () => {
  it("blocks publishing an exam with no questions", () => {
    const reason = examPublishBlocker("draft", 0, 5);
    assert.ok(reason);
    assert.match(reason, /builder/);
  });

  it("blocks publishing to an empty audience (prompt 19)", () => {
    const reason = examPublishBlocker("draft", 5, 0);
    assert.ok(reason);
    assert.match(reason, /at least one class or student/);
  });

  it("blocks publishing when the availability window already closed", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const reason = examPublishBlocker(
      "scheduled",
      5,
      3,
      "2026-01-01T00:00:00Z",
      now,
    );
    assert.ok(reason);
    assert.match(reason, /window has already ended/);
  });

  it("allows publishing a draft or scheduled exam with content and an audience", () => {
    assert.equal(examPublishBlocker("draft", 1, 1), null);
    assert.equal(examPublishBlocker("scheduled", 20, 4), null);
  });

  it("refuses publish attempts from non-publishable statuses", () => {
    assert.ok(examPublishBlocker("published", 10, 5));
    assert.ok(examPublishBlocker("closed", 10, 5));
    assert.ok(examPublishBlocker("archived", 10, 5));
  });
});

// --- Assignment audience (prompt 19) ---------------------------------------------

describe("examEffectiveStudentCount", () => {
  it("adds class rosters and direct students, minus the overlap", () => {
    assert.equal(
      examEffectiveStudentCount({
        classStudentCount: 30,
        directStudentCount: 5,
        overlapCount: 2,
      }),
      33,
    );
  });

  it("never double-counts a direct student already on a selected roster", () => {
    assert.equal(
      examEffectiveStudentCount({
        classStudentCount: 10,
        directStudentCount: 10,
        overlapCount: 10,
      }),
      10,
    );
  });

  it("clamps negatives and fractions to a sane non-negative integer", () => {
    assert.equal(
      examEffectiveStudentCount({
        classStudentCount: -5,
        directStudentCount: -3,
        overlapCount: 0,
      }),
      0,
    );
    assert.equal(
      examEffectiveStudentCount({
        classStudentCount: 10.7,
        directStudentCount: 0,
        overlapCount: 0,
      }),
      10,
    );
  });
});

describe("examIsAvailableToStudent", () => {
  const now = new Date("2026-01-10T12:00:00Z");

  it("grants access only to a published exam with an active assignment in-window", () => {
    assert.equal(
      examIsAvailableToStudent({
        status: "published",
        assignmentActive: true,
        startsAt: "2026-01-09T00:00:00Z",
        endsAt: "2026-01-11T00:00:00Z",
        now,
      }),
      true,
    );
  });

  it("refuses a scheduled or closed exam even with an active assignment", () => {
    assert.equal(
      examIsAvailableToStudent({
        status: "scheduled",
        assignmentActive: true,
        startsAt: null,
        endsAt: null,
        now,
      }),
      false,
    );
    assert.equal(
      examIsAvailableToStudent({
        status: "closed",
        assignmentActive: true,
        startsAt: null,
        endsAt: null,
        now,
      }),
      false,
    );
  });

  it("refuses access without an active assignment (id-guessing is never access)", () => {
    assert.equal(
      examIsAvailableToStudent({
        status: "published",
        assignmentActive: false,
        startsAt: null,
        endsAt: null,
        now,
      }),
      false,
    );
  });

  it("refuses before the window opens and after it closes", () => {
    assert.equal(
      examIsAvailableToStudent({
        status: "published",
        assignmentActive: true,
        startsAt: "2026-01-11T00:00:00Z",
        endsAt: "2026-01-12T00:00:00Z",
        now,
      }),
      false,
    );
    assert.equal(
      examIsAvailableToStudent({
        status: "published",
        assignmentActive: true,
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2026-01-05T00:00:00Z",
        now,
      }),
      false,
    );
  });
});

// --- Student dashboard buckets (prompt 20) ---------------------------------------

describe("studentExamBucket", () => {
  const now = new Date("2026-01-10T12:00:00Z");

  it("buckets an in-window published exam as available — exactly when delivery admits it", () => {
    const exam = {
      status: "published" as const,
      startsAt: "2026-01-09T00:00:00Z",
      endsAt: "2026-01-11T00:00:00Z",
      now,
    };
    assert.equal(studentExamBucket(exam), "available");
    // One source of truth: the dashboard bucket and the delivery gate agree.
    assert.equal(
      examIsAvailableToStudent({ ...exam, assignmentActive: true }),
      true,
    );
  });

  it("buckets a published exam whose window has not opened as upcoming", () => {
    assert.equal(
      studentExamBucket({
        status: "published",
        startsAt: "2026-01-11T00:00:00Z",
        endsAt: "2026-01-12T00:00:00Z",
        now,
      }),
      "upcoming",
    );
  });

  it("buckets a published exam whose window has passed as completed", () => {
    assert.equal(
      studentExamBucket({
        status: "published",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2026-01-05T00:00:00Z",
        now,
      }),
      "completed",
    );
  });

  it("treats a closed exam as history and an unscheduled published exam as open", () => {
    assert.equal(
      studentExamBucket({ status: "closed", startsAt: null, endsAt: null, now }),
      "completed",
    );
    assert.equal(
      studentExamBucket({
        status: "published",
        startsAt: null,
        endsAt: null,
        now,
      }),
      "available",
    );
  });

  it("returns null for statuses a student must never see (draft/scheduled/archived)", () => {
    for (const status of ["draft", "scheduled", "archived"] as const) {
      assert.equal(
        studentExamBucket({ status, startsAt: null, endsAt: null, now }),
        null,
      );
    }
  });

  it("ignores an unparseable window bound exactly like the delivery gate does", () => {
    // A garbage start bound is skipped rather than guessed — the same NaN
    // handling examIsAvailableToStudent applies, so bucket and gate agree.
    assert.equal(
      studentExamBucket({
        status: "published",
        startsAt: "not-a-date",
        endsAt: null,
        now,
      }),
      "available",
    );
  });
});

// --- Student eligibility & the start gate (prompt 21) ----------------------------

describe("studentExamEligibility", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  const base = {
    status: "published" as const,
    assignmentActive: true,
    startsAt: "2026-01-09T00:00:00Z",
    endsAt: "2026-01-11T00:00:00Z",
    attemptsUsed: 0,
    maxAttempts: 2,
    now,
  };

  it("is open inside the window with attempts remaining", () => {
    const result = studentExamEligibility(base);
    assert.equal(result.state, "open");
    assert.equal(result.attemptsRemaining, 2);
  });

  it("reports scheduled before the window opens", () => {
    assert.equal(
      studentExamEligibility({
        ...base,
        startsAt: "2026-01-11T00:00:00Z",
        endsAt: "2026-01-12T00:00:00Z",
      }).state,
      "scheduled",
    );
  });

  it("reports expired once the window has passed", () => {
    assert.equal(
      studentExamEligibility({
        ...base,
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2026-01-05T00:00:00Z",
      }).state,
      "expired",
    );
  });

  it("treats a closed exam as expired even while its window is still open", () => {
    // closed exams stay in the student's history but are never startable
    assert.equal(
      studentExamEligibility({ ...base, status: "closed" }).state,
      "expired",
    );
  });

  it("flags attempts exhausted rather than opening a start", () => {
    const result = studentExamEligibility({ ...base, attemptsUsed: 2, maxAttempts: 2 });
    assert.equal(result.state, "attempts_exhausted");
    assert.equal(result.attemptsRemaining, 0);
  });

  it("counts down remaining attempts against the budget", () => {
    assert.equal(
      studentExamEligibility({ ...base, attemptsUsed: 1, maxAttempts: 3 })
        .attemptsRemaining,
      2,
    );
  });

  it("fails closed to unavailable without an active assignment", () => {
    assert.equal(
      studentExamEligibility({ ...base, assignmentActive: false }).state,
      "unavailable",
    );
  });

  it("fails closed to unavailable for an unreleased status", () => {
    for (const status of ["draft", "scheduled", "archived"] as const) {
      assert.equal(
        studentExamEligibility({ ...base, status }).state,
        "unavailable",
      );
    }
  });

  it("treats a non-positive or bogus attempt limit as exhausted", () => {
    assert.equal(
      studentExamEligibility({ ...base, maxAttempts: 0 }).state,
      "attempts_exhausted",
    );
    assert.equal(
      studentExamEligibility({ ...base, attemptsUsed: Number.NaN }).state,
      "open",
    ); // NaN attempts collapse to 0, not a lockout
  });
});

describe("studentExamStartGate", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  const openBase = {
    status: "published" as const,
    assignmentActive: true,
    startsAt: "2026-01-09T00:00:00Z",
    endsAt: "2026-01-11T00:00:00Z",
    attemptsUsed: 0,
    maxAttempts: 1,
    now,
  };

  it("allows a start only when the eligibility is open", () => {
    assert.deepEqual(studentExamStartGate(openBase), { allowed: true });
  });

  it("refuses an unassigned student first, regardless of the window", () => {
    const gate = studentExamStartGate({ ...openBase, assignmentActive: false });
    assert.equal(gate.allowed, false);
    if (!gate.allowed) assert.match(gate.message, /not assigned to you/);
  });

  it("refuses before the window opens and after it closes", () => {
    const early = studentExamStartGate({
      ...openBase,
      startsAt: "2026-01-11T00:00:00Z",
      endsAt: "2026-01-12T00:00:00Z",
    });
    assert.equal(early.allowed, false);
    if (!early.allowed) assert.match(early.message, /not opened yet/);

    const late = studentExamStartGate({
      ...openBase,
      startsAt: "2026-01-01T00:00:00Z",
      endsAt: "2026-01-05T00:00:00Z",
    });
    assert.equal(late.allowed, false);
    if (!late.allowed) assert.match(late.message, /window has ended/);
  });

  it("refuses when the attempt budget is spent", () => {
    const gate = studentExamStartGate({ ...openBase, attemptsUsed: 1, maxAttempts: 1 });
    assert.equal(gate.allowed, false);
    if (!gate.allowed) assert.match(gate.message, /all the attempts/);
  });

  it("quotes the shared interface-unavailable message for a permitted start", () => {
    // The message the server action returns once every check passes today.
    assert.equal(typeof EXAM_START_INTERFACE_UNAVAILABLE_MESSAGE, "string");
    assert.match(EXAM_START_INTERFACE_UNAVAILABLE_MESSAGE, /examination interface/);
  });
});

// --- Edit safety: lifecycle locks (prompt 17 core rule) --------------------------

describe("examFieldEditable / examLockedFields", () => {
  it("keeps every field editable before publication", () => {
    for (const field of [
      "title",
      "subjectId",
      "categoryId",
      "durationMinutes",
      "startsAt",
      "endsAt",
      "maxAttempts",
      "shuffleQuestions",
      "shuffleOptions",
      "resultsRelease",
    ]) {
      assert.equal(examFieldEditable("draft", field), true);
      assert.equal(examFieldEditable("scheduled", field), true);
    }
    assert.deepEqual(examLockedFields("draft"), []);
    assert.deepEqual(examLockedFields("scheduled"), []);
  });

  it("freezes delivery-shaping fields at publish, keeps wording editable", () => {
    assert.equal(examFieldEditable("published", "durationMinutes"), false);
    assert.equal(examFieldEditable("published", "startsAt"), false);
    assert.equal(examFieldEditable("published", "endsAt"), false);
    assert.equal(examFieldEditable("published", "subjectId"), false);
    // the prompt 18 builder fields shape delivery too — they freeze likewise
    assert.equal(examFieldEditable("published", "categoryId"), false);
    assert.equal(examFieldEditable("published", "maxAttempts"), false);
    assert.equal(examFieldEditable("published", "shuffleQuestions"), false);
    assert.equal(examFieldEditable("published", "shuffleOptions"), false);
    assert.equal(examFieldEditable("published", "resultsRelease"), false);
    assert.equal(examFieldEditable("published", "title"), true);
    assert.equal(examFieldEditable("published", "description"), true);
    assert.deepEqual(examLockedFields("published"), [
      "subjectId",
      "categoryId",
      "durationMinutes",
      "startsAt",
      "endsAt",
      "maxAttempts",
      "shuffleQuestions",
      "shuffleOptions",
      "resultsRelease",
    ]);
  });

  it("freezes everything once closed or archived (the record is history)", () => {
    assert.equal(examFieldEditable("closed", "title"), false);
    assert.equal(examFieldEditable("archived", "description"), false);
    assert.equal(examLockedFields("closed").includes("title"), true);
    // 9 delivery fields + title + description
    assert.equal(examLockedFields("archived").length, 11);
    assert.equal(examLockedFields("closed").includes("resultsRelease"), true);
  });

  it("fails closed for unknown field names", () => {
    assert.equal(examFieldEditable("published", "status"), false);
    assert.equal(examFieldEditable("published", "__proto__"), false);
  });
});

// --- Builder edit safety (prompt 18 core rule) ------------------------------------

describe("examBuilderEditable", () => {
  it("allows question-set edits only while the exam is still being prepared", () => {
    assert.equal(examBuilderEditable("draft"), true);
    assert.equal(examBuilderEditable("scheduled"), true);
  });

  it("freezes the question set from publish onward (snapshots are history)", () => {
    assert.equal(examBuilderEditable("published"), false);
    assert.equal(examBuilderEditable("closed"), false);
    assert.equal(examBuilderEditable("archived"), false);
  });
});

describe("examTotalMarks", () => {
  it("sums per-question marks", () => {
    assert.equal(examTotalMarks([1, 2, 3]), 6);
    assert.equal(examTotalMarks([]), 0);
  });

  it("ignores non-finite entries instead of rendering a bogus total", () => {
    assert.equal(examTotalMarks([2, Number.NaN, 3]), 5);
  });
});

describe("examQuestionMarksError", () => {
  it("mirrors the DB marks CHECK (1–50, whole numbers)", () => {
    assert.equal(examQuestionMarksError(EXAM_QUESTION_MARKS_MIN), null);
    assert.equal(examQuestionMarksError(EXAM_QUESTION_MARKS_MAX), null);
    assert.ok(examQuestionMarksError(0));
    assert.ok(examQuestionMarksError(EXAM_QUESTION_MARKS_MAX + 1));
    assert.ok(examQuestionMarksError(2.5));
    assert.ok(examQuestionMarksError("10"));
    assert.ok(examQuestionMarksError(undefined));
  });
});

describe("examBuilderWarnings", () => {
  it("warns an empty selection cannot be published", () => {
    const warnings = examBuilderWarnings({
      questionCount: 0,
      totalMarks: 0,
      scheduled: true,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /add at least one from the question bank/);
  });

  it("flags a zero-mark selection and a missing availability window", () => {
    const warnings = examBuilderWarnings({
      questionCount: 5,
      totalMarks: 0,
      scheduled: false,
    });
    assert.equal(warnings.length, 2);
    assert.match(warnings.join(" "), /0 marks/);
    assert.match(warnings.join(" "), /availability window/);
  });

  it("stays silent for a complete, scheduled selection", () => {
    assert.deepEqual(
      examBuilderWarnings({ questionCount: 10, totalMarks: 50, scheduled: true }),
      [],
    );
  });
});

// --- List query resolution --------------------------------------------------------

describe("resolveExamListQuery", () => {
  it("returns safe defaults when the URL is empty", () => {
    assert.deepEqual(resolveExamListQuery({}), {
      q: "",
      subjectId: "",
      status: null,
      page: 1,
      pageSize: EXAM_PAGE_SIZE,
    });
  });

  it("clamps hostile or stale values from the URL", () => {
    const query = resolveExamListQuery({
      q: "  mid-term  ",
      status: "active", // a display state is not a stored status
      page: "-4",
    });
    assert.equal(query.q, "mid-term");
    assert.equal(query.status, null); // unknown status → all
    assert.equal(query.page, 1);
  });

  it("narrows to known statuses only and takes first of repeated params", () => {
    assert.equal(resolveExamListQuery({ status: "published" }).status, "published");
    assert.equal(resolveExamListQuery({ status: ["closed", "draft"] }).status, "closed");
    assert.equal(resolveExamListQuery({ page: ["3", "9"] }).page, 3);
  });

  it("length-bounds the search term and subject filter", () => {
    const query = resolveExamListQuery({ q: "x".repeat(500), subject: "s".repeat(200) });
    assert.equal(query.q.length, 120);
    assert.equal(query.subjectId.length, 64);
  });
});

describe("examPageHref", () => {
  it("omits filters and page 1 from the URL", () => {
    const query = resolveExamListQuery({});
    assert.equal(examPageHref("/teacher/exams", query, 1), "/teacher/exams");
  });

  it("preserves every active filter across pages", () => {
    const query = resolveExamListQuery({ q: "mock", subject: "subj-1", status: "published" });
    assert.equal(
      examPageHref("/teacher/exams", query, 2),
      "/teacher/exams?q=mock&subject=subj-1&status=published&page=2",
    );
  });
});

// --- Display helpers --------------------------------------------------------------

describe("formatDuration", () => {
  it("renders minutes and hour/minute combinations", () => {
    assert.equal(formatDuration(45), "45 min");
    assert.equal(formatDuration(60), "1 hr");
    assert.equal(formatDuration(90), "1 hr 30 min");
    assert.equal(formatDuration(0), "—");
  });
});

describe("toDatetimeLocalValue", () => {
  it("formats an ISO timestamp for the datetime-local input", () => {
    const value = toDatetimeLocalValue("2026-11-01T09:00:00");
    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("returns empty string for unset or invalid input", () => {
    assert.equal(toDatetimeLocalValue(null), "");
    assert.equal(toDatetimeLocalValue("not a date"), "");
  });
});

// --- Permission catalog wiring ------------------------------------------------------

describe("exam.manage catalog entry", () => {
  it("is held by teachers and institution admins, never students/super-admin", () => {
    assert.equal(hasPermission("TEACHER", "exam.manage"), true);
    assert.equal(hasPermission("INSTITUTION_ADMIN", "exam.manage"), true);
    assert.equal(hasPermission("STUDENT", "exam.manage"), false);
    assert.equal(hasPermission("SUPER_ADMIN", "exam.manage"), false);
    assert.equal(hasPermission(null, "exam.manage"), false);
  });
});

describe("exam.publish catalog entry", () => {
  it("gates publishing to the manager roles only", () => {
    assert.equal(hasPermission("TEACHER", "exam.publish"), true);
    assert.equal(hasPermission("INSTITUTION_ADMIN", "exam.publish"), true);
    assert.equal(hasPermission("STUDENT", "exam.publish"), false);
    assert.equal(hasPermission("SUPER_ADMIN", "exam.publish"), false);
  });
});

// --- Tenant + privilege boundary via the resource engine -----------------------------

function member(role: UserRole | null, institutionId: string | null): AuthPrincipal {
  return {
    userId: "user_1",
    role,
    institutionId,
    hasMembership: role !== null && (role === "SUPER_ADMIN" || institutionId !== null),
  };
}

function signedIn(role: UserRole | null, institutionId: string | null): AccessSubject {
  return { session: "active", principal: member(role, institutionId) };
}

function examRequest(
  permission: ResourceAccessRequest["permission"],
  operation: ResourceAccessRequest["operation"],
  overrides: Partial<ResourceDescriptor> = {},
): ResourceAccessRequest {
  return {
    permission,
    operation,
    resource: { kind: "exam", institutionId: INSTITUTION_A, ...overrides },
  };
}

describe("exam boundary", () => {
  it("grants a teacher read/update of an exam in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("TEACHER", INSTITUTION_A), examRequest("exam.manage", "read")).allowed,
      true,
    );
    assert.equal(
      checkResourceAccess(signedIn("TEACHER", INSTITUTION_A), examRequest("exam.manage", "update")).allowed,
      true,
    );
  });

  it("grants an institution admin read/update in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), examRequest("exam.manage", "read")).allowed,
      true,
    );
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), examRequest("exam.publish", "update")).allowed,
      true,
    );
  });

  it("denies a teacher DELETING an exam (archive is the only retirement)", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      examRequest("exam.manage", "delete"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies a student the exam area entirely", () => {
    const decision = checkResourceAccess(
      signedIn("STUDENT", INSTITUTION_A),
      examRequest("exam.manage", "read"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies acting on another institution's exam (cross-tenant)", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      examRequest("exam.manage", "update", { institutionId: INSTITUTION_B }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "tenantMismatch");
  });
});

// --- The tenant invariant the exam actions rely on -----------------------------------
// Every exam page and action does `principal.institutionId as string` after
// `requireRole(["TEACHER","INSTITUTION_ADMIN"])`. That cast is only sound
// because a manager with no usable tenant can NEVER be authorized. These tests
// pin that guarantee so the data layer never scopes to `null`.
describe("exam flow tenant invariant (why the institutionId cast is safe)", () => {
  it("a teacher with no institution has no membership and is denied", () => {
    const principal = readTrustedPrincipal({
      userId: "user_teacher",
      privateMetadata: { role: "TEACHER" },
    });
    assert.ok(principal);
    assert.equal(principal.hasMembership, false);

    const decision = decideAccess(
      { session: "active", principal },
      { roles: ["TEACHER", "INSTITUTION_ADMIN"] },
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "noMembership");
  });

  it("a blank/whitespace institution id is treated as absent (fail closed)", () => {
    const principal = readTrustedPrincipal({
      userId: "user_teacher",
      privateMetadata: { role: "TEACHER", institutionId: "   " },
    });
    assert.ok(principal);
    assert.equal(principal.institutionId, null);
    assert.equal(principal.hasMembership, false);
  });
});
