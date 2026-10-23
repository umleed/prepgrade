/**
 * Automated testing & QA — the critical assessment workflow (prompt 39).
 *
 * One focused suite that chains the REAL contract modules in `lib/` through
 * the end-to-end scenario the product must prove:
 *   institution setup → teacher/student membership → question creation →
 *   exam create/publish/assign → student starts → answers save → refresh
 *   recovery → submission → server grading → released result for the student
 *   → permitted analytics for the teacher (AGENTS.md §6's core loop).
 * It then hammers the boundaries prompt 39 names: role permissions and
 * cross-tenant denial (§5), invalid inputs, unavailable/scheduled/expired
 * exams, refresh recovery, duplicate submissions, timer expiry, and grading
 * edge cases.
 *
 * WHAT IS AND IS NOT COVERED HERE (honesty per AGENTS.md §2.7)
 * These tests exercise the pure rule layer that BOTH the browser and the
 * server handlers call — the single source of truth for validation,
 * lifecycle, timing, randomisation, grading, release, and authorization
 * decisions. They do NOT open a database: `npm test` has no live Postgres,
 * so the Supabase data layer (lib/data/*), migrations, and deployed RLS are
 * not executed. Those guarantees are carried by the SQL readiness harnesses
 * under supabase/tests/ (exams, exam_builder, exam_assignment,
 * exam_attempts, exam_results, questions, …) which must be run against a
 * real Supabase project before a deployment is called verified — running
 * them is out of reach here and is reported as a limitation, not claimed
 * as passing.
 *
 * No new test framework: `node --test`, zero dependencies, matching the
 * existing suites (tests/attempts, tests/grading, tests/auth, …).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeContactPhone,
  validateInstitutionRegistration,
} from "../../lib/institutions.ts";
import {
  canApplyDecision,
  DECISION_TARGET_STATUS,
} from "../../lib/institution-applications.ts";
import { validateClass } from "../../lib/classes.ts";
import { normalizeStudentInput, validateStudent } from "../../lib/students.ts";
import {
  normalizeTeacherInput,
  resolveGrantableTeacherRole,
  validateTeacher,
} from "../../lib/teachers.ts";
import {
  QUESTION_INPUT_EMPTY,
  normalizeQuestionInput,
  questionMeaningChanged,
  validateQuestion,
  type QuestionInput,
} from "../../lib/questions.ts";
import {
  EXAM_INPUT_EMPTY,
  canTransitionExam,
  examBuilderEditable,
  examBuilderWarnings,
  examDisplayState,
  examEffectiveStudentCount,
  examFieldEditable,
  examIsAvailableToStudent,
  examPublishBlocker,
  examQuestionMarksError,
  examTotalMarks,
  normalizeExamInput,
  studentExamEligibility,
  studentExamStartGate,
  validateExam,
  type ExamInput,
} from "../../lib/exams.ts";
import {
  attemptIsLocked,
  attemptQuestionNavState,
  attemptSubmitDecision,
  attemptTimeRemainingMs,
  buildOptionOrder,
  canAcceptAnswer,
  canonicalToDisplay,
  computeAttemptExpiresAt,
  countAnswered,
  displayToCanonical,
  formatCountdown,
  type AttemptQuestionPresentation,
  type ExamAttemptStatus,
} from "../../lib/attempts.ts";
import {
  canRevealAnswers,
  computeTimeUsedSeconds,
  gradeObjectiveAnswers,
  isResultReleased,
  roundPercentage,
  type GradingQuestion,
  type GradingResult,
} from "../../lib/grading.ts";
import {
  buildSubjectRows,
  formatPercentage,
  formatScore,
  formatTimeUsed,
  releaseHint,
  studentResultVisibility,
} from "../../lib/results.ts";
import {
  computeClassSummary,
  gradeForPercentage,
  type AnalyticsResultRow,
} from "../../lib/analytics.ts";
import { summarizeStudentPerformance } from "../../lib/student-performance.ts";
import { decideAccess } from "../../lib/auth/access.ts";
import { hasPermission } from "../../lib/auth/permissions.ts";
import {
  canViewAnswerKey,
  checkResourceAccess,
  redactRestrictedFields,
} from "../../lib/auth/resource-access.ts";
import { readTrustedPrincipal, type AuthPrincipal } from "../../lib/auth/principal.ts";

// --- Deterministic world ----------------------------------------------------
// Fixed tenants, users, and a fixed exam window so every timestamp in the
// flow is an explicit, trusted constant (the same posture the data layer
// takes: the server clock, not the client, decides).

const INST_A = "inst-green-acres";
const INST_B = "inst-rival-academy";
const SUBJECT_MATH = "subj-math";
const CLASS_SS2 = "class-ss2-gold";

const WINDOW_START = "2026-02-01T08:00:00.000Z";
const WINDOW_END = "2026-02-01T10:00:00.000Z";
const SERVER_START = "2026-02-01T09:00:00.000Z";
const DURATION_MINUTES = 30;

function at(iso: string): Date {
  return new Date(iso);
}
function ms(iso: string): number {
  return Date.parse(iso);
}

/** xorshift32 — the same deterministic rng the attempts suite uses, so the
 *  shuffle is reproducible and failures can be re-run exactly. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const rng = makeRng(0x5eed39);

// Principals are read the way production reads them: from server-written
// Clerk privateMetadata only (AGENTS.md §5 — never client-supplied roles).
function principalFor(
  userId: string,
  role: unknown,
  institutionId: string | null,
): AuthPrincipal {
  const principal = readTrustedPrincipal({
    userId,
    privateMetadata: { role, institutionId },
  });
  assert.ok(principal, "trusted metadata yields a principal");
  return principal;
}

const ADMIN_A = principalFor("user-admin-a", "INSTITUTION_ADMIN", INST_A);
const TEACHER_A = principalFor("user-teacher-a", "TEACHER", INST_A);
const STUDENT_ADA = principalFor("user-ada", "STUDENT", INST_A);
const STUDENT_BOLA = principalFor("user-bola", "STUDENT", INST_A);
const TEACHER_B = principalFor("user-teacher-b", "TEACHER", INST_B);
const SUPER_ADMIN = principalFor("user-platform", "SUPER_ADMIN", null);

/** The frozen exam snapshot (0011) reduced to what delivery + grading need.
 *  `correctOptionIndex` is privileged — it never leaves the server until the
 *  release policy allows (it is deliberately absent from every presentation
 *  built below). */
type SnapshotQuestion = {
  snapshotId: string;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  marks: number;
  subjectId: string;
};

const SNAPSHOT_QUESTIONS: SnapshotQuestion[] = [
  {
    snapshotId: "snap-q1",
    questionText: "Solve for x: 2x + 6 = 14.",
    options: ["2", "4", "6", "8"],
    correctOptionIndex: 1,
    marks: 2,
    subjectId: SUBJECT_MATH,
  },
  {
    snapshotId: "snap-q2",
    questionText: "What is 7 × 8?",
    options: ["54", "56", "64", "72"],
    correctOptionIndex: 1,
    marks: 2,
    subjectId: SUBJECT_MATH,
  },
  {
    snapshotId: "snap-q3",
    questionText: "The capital of Nigeria is ___.",
    options: ["Lagos", "Abuja", "Kano", "Ibadan"],
    correctOptionIndex: 1,
    marks: 2,
    subjectId: SUBJECT_MATH,
  },
  {
    snapshotId: "snap-q4",
    questionText: "Round 4.7 to the nearest whole number.",
    options: ["4", "5", "4.5", "6"],
    correctOptionIndex: 1,
    marks: 4,
    subjectId: SUBJECT_MATH,
  },
];

function baseQuestion(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    ...QUESTION_INPUT_EMPTY,
    questionText: "Solve for x: 2x + 6 = 14.",
    subjectId: SUBJECT_MATH,
    topicId: "topic-algebra",
    options: ["2", "4", "6", "8"],
    correctOptionIndex: 1,
    explanation: "Subtract 6, divide by 2.",
    marks: 2,
    ...overrides,
  };
}

function baseExam(overrides: Partial<ExamInput> = {}): ExamInput {
  return {
    ...EXAM_INPUT_EMPTY,
    title: "SS2 Mathematics — Term 2 CBT",
    description: "End-of-term objective test.",
    subjectId: SUBJECT_MATH,
    durationMinutes: DURATION_MINUTES,
    startsAt: WINDOW_START,
    endsAt: WINDOW_END,
    maxAttempts: 2,
    shuffleOptions: true,
    resultsRelease: "after_window",
    ...overrides,
  };
}

// --- Stage 1 · institution setup, membership, authoring ----------------------

describe("critical workflow stage 1 — institution setup and membership", () => {
  it("registers the institution, approves the application, and trusts the admin membership", () => {
    const registration = validateInstitutionRegistration({
      name: "Green Acres College",
      type: "school",
      shortName: "Green Acres",
      description: "",
      country: "Nigeria",
      state: "Lagos",
      city: "Ikeja",
      address: "12 Akinola Olowu Road",
      contactPerson: "Mrs. Adaeze Okonkwo",
      contactEmail: "Admin@GreenAcres.School.NG",
      contactPhone: "(0803) 123-4567",
    });
    assert.equal(registration.ok, true);
    if (!registration.ok) return; // narrow for the asserts below
    // Email is lower-cased for stable uniqueness; the phone is normalised.
    assert.equal(registration.value.contactEmail, "admin@greenacres.school.ng");
    assert.equal(registration.value.contactPhone, "08031234567");
    assert.equal(registration.value.shortName, "Green Acres");
    assert.equal(registration.value.description, null, "blank stays null");

    // The platform review approves a pending application exactly once;
    // approved is terminal (no re-approval, no silent reopen).
    assert.equal(canApplyDecision("pending_review", "approve"), true);
    assert.equal(DECISION_TARGET_STATUS.approve, "approved");
    assert.equal(canApplyDecision("approved", "approve"), false);

    // The admin's membership comes from trusted metadata only.
    assert.equal(ADMIN_A.role, "INSTITUTION_ADMIN");
    assert.equal(ADMIN_A.institutionId, INST_A);
    assert.equal(ADMIN_A.hasMembership, true);
    const decision = decideAccess(
      { session: "active", principal: ADMIN_A },
      { roles: ["INSTITUTION_ADMIN"], institutionId: INST_A },
    );
    assert.equal(decision.allowed, true);
  });

  it("refuses a malformed registration rather than creating a broken tenant", () => {
    const bad = validateInstitutionRegistration({
      name: "",
      type: "facebook",
      country: "Nigeria",
      state: "Lagos",
      city: "Ikeja",
      address: "Somewhere",
      contactPerson: "Someone",
      contactEmail: "not-an-email",
      contactPhone: "call me",
    });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.ok(bad.errors.name);
    assert.ok(bad.errors.type);
    assert.ok(bad.errors.contactEmail);
    assert.ok(bad.errors.contactPhone);
    assert.equal(normalizeContactPhone("call me"), null);
  });

  it("adds a teacher, a class, and two students within the tenant", () => {
    const teacher = normalizeTeacherInput(
      (() => {
        const input = {
          fullName: "Mr. Samuel Adeyemi",
          email: "S.Adeyemi@GreenAcres.School.NG",
          employeeCode: "STAFF-014",
          classIds: [CLASS_SS2],
        };
        assert.deepEqual(validateTeacher(input), {});
        return input;
      })(),
    );
    assert.equal(teacher.email, "s.adeyemi@greenacres.school.ng");
    // Only TEACHER may ever be granted through teacher management (§5).
    assert.equal(resolveGrantableTeacherRole("TEACHER"), "TEACHER");
    assert.equal(resolveGrantableTeacherRole("INSTITUTION_ADMIN"), null);
    assert.equal(resolveGrantableTeacherRole("SUPER_ADMIN"), null);

    const cls = { name: "SS2 Gold", academicSessionId: "session-2025-2026" };
    assert.deepEqual(validateClass(cls), {});

    const ada = normalizeStudentInput({
      fullName: " Ada Chukwu ",
      studentCode: "PG/2026/001",
      classId: CLASS_SS2,
      status: "active",
    });
    assert.deepEqual(validateStudent(ada), {});
    assert.equal(ada.fullName, "Ada Chukwu", "names are trimmed before storage");
    const bola = {
      fullName: "Bola Aminu",
      studentCode: "PG/2026/002",
      classId: CLASS_SS2,
      status: "active",
    };
    assert.deepEqual(validateStudent(bola), {});
  });
});

describe("critical workflow stage 2 — question creation", () => {
  it("the teacher authors a gradeable MCQ and the bank accepts it", () => {
    assert.deepEqual(validateQuestion(baseQuestion()), {});
    const clean = normalizeQuestionInput(baseQuestion({ questionText: "  Solve for x: 2x + 6 = 14.  " }));
    assert.equal(clean.questionText, "Solve for x: 2x + 6 = 14.");

    // The teacher may see the key of their own tenant's question…
    assert.equal(hasPermission(TEACHER_A.role, "question.manage"), true);
    assert.equal(hasPermission(TEACHER_A.role, "question.read_answer_key"), true);
    // …but a student holds neither.
    assert.equal(hasPermission(STUDENT_ADA.role, "question.manage"), false);
    assert.equal(hasPermission(STUDENT_ADA.role, "question.read_answer_key"), false);
  });

  it("rejects questions the grading engine could never score", () => {
    assert.ok(validateQuestion(baseQuestion({ questionText: "  " })).questionText);
    assert.ok(validateQuestion(baseQuestion({ options: ["2"] })).options);
    assert.ok(validateQuestion(baseQuestion({ options: ["2", "  "] })).options);
    // Duplicates are caught case-insensitively, so "Two"/"two" cannot ship.
    assert.ok(validateQuestion(baseQuestion({ options: ["Two", "two", "3", "4"] })).options);
    assert.ok(validateQuestion(baseQuestion({ correctOptionIndex: 9 })).correctOptionIndex);
    assert.ok(validateQuestion(baseQuestion({ marks: 0 })).marks);
    assert.ok(validateQuestion(baseQuestion({ questionType: "essay" as never })).questionType);

    // Meaning vs metadata (prompt 16): only meaning edits create a version.
    const current = {
      questionText: "Solve for x: 2x + 6 = 14.",
      questionType: "mcq_single",
      options: ["2", "4", "6", "8"],
      correctOptionIndex: 1,
      marks: 2,
    };
    assert.equal(
      questionMeaningChanged(current, baseQuestion({ explanation: "Cleaner wording." })),
      false,
    );
    assert.equal(
      questionMeaningChanged(current, baseQuestion({ correctOptionIndex: 2 })),
      true,
      "moving the answer key is a meaning change",
    );
  });
});

describe("critical workflow stage 3 — exam creation, builder, publish, assignment", () => {
  it("validates the exam configuration against the DB-mirroring bounds", () => {
    assert.deepEqual(validateExam(baseExam()), {});
    const normalized = normalizeExamInput(baseExam({ title: "  SS2 Math  " }));
    assert.equal(normalized.title, "SS2 Math");

    assert.ok(validateExam(baseExam({ title: "" })).title);
    assert.ok(validateExam(baseExam({ subjectId: "" })).subjectId);
    assert.ok(validateExam(baseExam({ durationMinutes: 0 })).durationMinutes);
    assert.ok(validateExam(baseExam({ durationMinutes: 481 })).durationMinutes);
    assert.ok(validateExam(baseExam({ maxAttempts: 11 })).maxAttempts);
    assert.ok(validateExam(baseExam({ resultsRelease: "whenever" as never })).resultsRelease);
    assert.ok(validateExam(baseExam({ startsAt: WINDOW_END, endsAt: WINDOW_START })).endsAt);
    // One window bound without the other is refused on the MISSING side.
    assert.ok(validateExam(baseExam({ endsAt: "" })).endsAt);
    assert.ok(validateExam(baseExam({ startsAt: "" })).startsAt);
  });

  it("blocks publishing until questions, audience, and window are real", () => {
    const now = at(WINDOW_START);
    assert.match(
      examPublishBlocker("draft", 0, 0, WINDOW_END, now) ?? "",
      /at least one question/i,
    );
    assert.match(
      examPublishBlocker("draft", SNAPSHOT_QUESTIONS.length, 0, WINDOW_END, now) ?? "",
      /at least one class or student/i,
    );
    assert.match(
      examPublishBlocker("draft", SNAPSHOT_QUESTIONS.length, 3, "2026-01-01T00:00:00.000Z", now) ?? "",
      /window has already ended/i,
    );

    // The builder adds the four authored questions; marks are validated and summed.
    const marks = SNAPSHOT_QUESTIONS.map((question) => question.marks);
    assert.equal(examQuestionMarksError(0), "Marks must be from 1 to 50.");
    assert.equal(examQuestionMarksError(1.5), "Marks must be a whole number.");
    assert.equal(examTotalMarks(marks), 10);

    // Audience: two class roster students + one direct assignment, one of whom
    // is already on the roster — the union is three, not four (prompt 19).
    const audience = examEffectiveStudentCount({
      classStudentCount: 2,
      directStudentCount: 2,
      overlapCount: 1,
    });
    assert.equal(audience, 3);

    assert.deepEqual(
      examBuilderWarnings({ questionCount: marks.length, totalMarks: examTotalMarks(marks), scheduled: true }),
      [],
    );

    // draft → scheduled → published are the legal forward moves.
    assert.equal(canTransitionExam("draft", "scheduled"), true);
    assert.equal(canTransitionExam("scheduled", "published"), true);
    assert.equal(examPublishBlocker("scheduled", marks.length, audience, WINDOW_END, now), null);
  });

  it("freezes delivery-shaping facts at publish so history cannot drift", () => {
    assert.equal(examBuilderEditable("draft"), true);
    assert.equal(examBuilderEditable("published"), false, "the frozen snapshot is now the truth");
    assert.equal(examFieldEditable("published", "durationMinutes"), false);
    assert.equal(examFieldEditable("published", "resultsRelease"), false);
    assert.equal(examFieldEditable("published", "title"), true, "wording may still be fixed");
    assert.equal(examFieldEditable("closed", "title"), false, "closed is history");
    assert.equal(canTransitionExam("published", "draft"), false);
    assert.equal(canTransitionExam("published", "closed"), true);

    // Display state derives from the ONE lifecycle + window, never a second enum.
    assert.equal(examDisplayState("published", WINDOW_START, WINDOW_END, at("2026-02-01T09:00:00Z")).label, "Active");
    assert.equal(examDisplayState("published", WINDOW_START, WINDOW_END, at("2026-02-02T09:00:00Z")).label, "Completed");
  });
});

// --- Stage 4 · delivery: start, save, recover, submit ------------------------

describe("critical workflow stage 4 — student delivery (start → save → recover → submit)", () => {
  // Mutable attempt world, advanced by each `it` in order — the same
  // forward-only lifecycle the server enforces (prompt 23).
  let attemptStatus: ExamAttemptStatus = "in_progress";
  let expiresAtMs = 0;
  let gradedResult: GradingResult | null = null;
  let timeUsedSeconds = 0;
  const optionOrders = new Map<string, number[]>();
  const storedAnswers = new Map<string, number>(); // snapshotId → CANONICAL index
  const reviewFlags = new Set<string>();

  function presentationFor(question: SnapshotQuestion, position: number): AttemptQuestionPresentation {
    const order = optionOrders.get(question.snapshotId)!;
    return {
      snapshotId: question.snapshotId,
      position,
      questionText: question.questionText,
      options: order.map((canonical, displayIndex) => ({
        displayIndex,
        text: question.options[canonical],
      })),
      marks: question.marks,
      difficulty: "medium",
    };
  }

  /** Exactly what the save endpoint does: gate on stored server facts, map
   *  the client's DISPLAY index to the canonical one, persist only that. */
  function selectAnswer(snapshotId: string, displayIndex: number, nowIso: string): boolean {
    if (!canAcceptAnswer({ status: attemptStatus, expiresAtMs, nowMs: ms(nowIso) })) return false;
    const canonical = displayToCanonical(optionOrders.get(snapshotId) ?? [], displayIndex);
    if (canonical === null) return false;
    storedAnswers.set(snapshotId, canonical);
    return true;
  }

  it("a student may only start an assigned, published exam inside its window", () => {
    // Before the window opens the start gate refuses with the honest reason.
    const early = studentExamStartGate({
      status: "published",
      assignmentActive: true,
      startsAt: WINDOW_START,
      endsAt: WINDOW_END,
      attemptsUsed: 0,
      maxAttempts: 2,
      now: at("2026-02-01T07:00:00Z"),
    });
    assert.equal(early.allowed, false);
    if (early.allowed) return;
    assert.match(early.message, /not opened yet/i);

    // Guessing the id of an exam that is not assigned fails closed.
    assert.equal(
      examIsAvailableToStudent({
        status: "published",
        assignmentActive: false,
        startsAt: WINDOW_START,
        endsAt: WINDOW_END,
        now: at(SERVER_START),
      }),
      false,
    );

    // Inside the window, assigned: the gate opens and reports the budget.
    const open = studentExamStartGate({
      status: "published",
      assignmentActive: true,
      startsAt: WINDOW_START,
      endsAt: WINDOW_END,
      attemptsUsed: 0,
      maxAttempts: 2,
      now: at(SERVER_START),
    });
    assert.equal(open.allowed, true);
    const eligibility = studentExamEligibility({
      status: "published",
      assignmentActive: true,
      startsAt: WINDOW_START,
      endsAt: WINDOW_END,
      attemptsUsed: 0,
      maxAttempts: 2,
      now: at(SERVER_START),
    });
    assert.equal(eligibility.state, "open");
    assert.equal(eligibility.attemptsRemaining, 2);
  });

  it("the server stamps the deadline and the shuffle keeps the answer key", () => {
    expiresAtMs = computeAttemptExpiresAt({
      startedAtMs: ms(SERVER_START),
      durationMinutes: DURATION_MINUTES,
      examEndsAtMs: ms(WINDOW_END),
    });
    assert.equal(expiresAtMs, ms("2026-02-01T09:30:00Z"), "30 minutes, window end is later");

    // A late start is capped by the window, not given a fresh full duration.
    const capped = computeAttemptExpiresAt({
      startedAtMs: ms("2026-02-01T09:45:00Z"),
      durationMinutes: DURATION_MINUTES,
      examEndsAtMs: ms(WINDOW_END),
    });
    assert.equal(capped, ms(WINDOW_END));

    for (const question of SNAPSHOT_QUESTIONS) {
      optionOrders.set(question.snapshotId, buildOptionOrder(question.options.length, true, rng));
    }
    for (const [snapshotId, order] of optionOrders) {
      const sorted = [...order].sort((a, b) => a - b);
      assert.deepEqual(sorted, [0, 1, 2, 3], `${snapshotId}: the permutation keeps every option exactly once`);
      const question = SNAPSHOT_QUESTIONS.find((item) => item.snapshotId === snapshotId)!;
      // The display slot holding the key still maps back to the frozen key.
      const display = canonicalToDisplay(order, question.correctOptionIndex)!;
      assert.equal(displayToCanonical(order, display), question.correctOptionIndex);
    }

    // The student-facing payload never carries the key (AGENTS.md §6).
    const sample = presentationFor(SNAPSHOT_QUESTIONS[0], 1);
    assert.equal(Object.keys(sample).includes("correctOptionIndex"), false);
    assert.equal(JSON.stringify(sample).includes("correctOptionIndex"), false);
  });

  it("saves answers while open, and a refresh recovers without resetting the clock", () => {
    assert.equal(canAcceptAnswer({ status: "in_progress", expiresAtMs, nowMs: ms("2026-02-01T09:10:00Z") }), true);

    // Ada answers q1 and q4 correctly, q2 wrongly; q3 she flags for review.
    const q1Order = optionOrders.get("snap-q1")!;
    assert.equal(selectAnswer("snap-q1", canonicalToDisplay(q1Order, 1)!, "2026-02-01T09:05:00Z"), true);
    const q2Order = optionOrders.get("snap-q2")!;
    const q2WrongDisplay = canonicalToDisplay(q2Order, 0)!;
    assert.equal(selectAnswer("snap-q2", q2WrongDisplay, "2026-02-01T09:08:00Z"), true);
    const q4Order = optionOrders.get("snap-q4")!;
    assert.equal(selectAnswer("snap-q4", canonicalToDisplay(q4Order, 1)!, "2026-02-01T09:09:00Z"), true);
    reviewFlags.add("snap-q3");
    assert.equal(storedAnswers.has("snap-q3"), false, "a review flag is not an answer");

    // Out-of-range / malformed display indices are refused, never stored.
    assert.equal(selectAnswer("snap-q1", 4, "2026-02-01T09:10:00Z"), false);
    assert.equal(selectAnswer("snap-q1", -1, "2026-02-01T09:10:00Z"), false);
    assert.equal(selectAnswer("snap-q1", 0.5, "2026-02-01T09:10:00Z"), false);

    const nav = new Map<string, ReturnType<typeof attemptQuestionNavState>>();
    for (const question of SNAPSHOT_QUESTIONS) {
      nav.set(
        question.snapshotId,
        attemptQuestionNavState(storedAnswers.has(question.snapshotId), reviewFlags.has(question.snapshotId)),
      );
    }
    assert.equal(countAnswered(nav), 3);

    // REFRESH: the browser reloads from the stored attempt. The saved
    // canonical answer maps back to the SAME display slot the student chose,
    // and the countdown continues from the stored expiresAt — refreshing
    // never restarts or extends the attempt.
    const q1RestoreDisplay = canonicalToDisplay(q1Order, storedAnswers.get("snap-q1")!);
    assert.equal(q1RestoreDisplay, canonicalToDisplay(q1Order, 1), "recovery shows the student's original selection");
    assert.equal(displayToCanonical(q1Order, q1RestoreDisplay!), storedAnswers.get("snap-q1"));
    assert.equal(attemptIsLocked(attemptStatus), false);
    assert.equal(expiresAtMs, ms("2026-02-01T09:30:00Z"), "the deadline survived the refresh untouched");
    assert.equal(attemptTimeRemainingMs(expiresAtMs, ms("2026-02-01T09:15:00Z")), 15 * 60_000);
    assert.equal(formatCountdown(attemptTimeRemainingMs(expiresAtMs, ms("2026-02-01T09:29:59Z"))), "0:01");
  });

  it("submitting locks the attempt and a duplicate submit is an idempotent no-op", () => {
    const submit = attemptSubmitDecision({ status: attemptStatus, expiresAtMs, nowMs: ms("2026-02-01T09:20:00Z") });
    assert.deepEqual(submit, { outcome: "submitted", next: "submitted" });
    if (submit.outcome !== "submitted") return;
    attemptStatus = submit.next;

    // Double-click / retry / second tab: same terminal state, no rewrite.
    const again = attemptSubmitDecision({ status: attemptStatus, expiresAtMs, nowMs: ms("2026-02-01T09:20:30Z") });
    assert.deepEqual(again, { outcome: "already_submitted" });

    // A stale tab cannot smuggle a save past submission.
    assert.equal(canAcceptAnswer({ status: attemptStatus, expiresAtMs, nowMs: ms("2026-02-01T09:21:00Z") }), false);
    assert.equal(selectAnswer("snap-q3", 0, "2026-02-01T09:21:00Z"), false);
    assert.equal(storedAnswers.has("snap-q3"), false, "the locked refusal changed nothing");
    assert.equal(attemptIsLocked(attemptStatus), true);
  });

  it("the server grades the LOCKED attempt from frozen keys and canonical answers", () => {
    const input: GradingQuestion[] = SNAPSHOT_QUESTIONS.map((question) => ({
      snapshotId: question.snapshotId,
      marks: question.marks,
      correctOptionIndex: question.correctOptionIndex,
      selectedOptionIndex: storedAnswers.get(question.snapshotId) ?? null,
      subjectId: question.subjectId,
    }));

    const result = gradeObjectiveAnswers(input);
    assert.equal(result.totalScore, 6, "q1 (2) + q4 (4)");
    assert.equal(result.maxScore, 10);
    assert.equal(result.percentage, 60);
    assert.equal(result.correctCount, 2);
    assert.equal(result.incorrectCount, 1);
    assert.equal(result.unansweredCount, 1);
    assert.equal(result.totalQuestions, 4);
    assert.deepEqual(
      result.correctCount + result.incorrectCount + result.unansweredCount,
      result.totalQuestions,
      "buckets are disjoint and complete",
    );
    assert.deepEqual(result.subjectBreakdown, [
      { subjectId: SUBJECT_MATH, correct: 2, total: 4, score: 6, maxScore: 10 },
    ]);

    // Determinism = retry safety: a re-run of the grade rewrites identical
    // numbers, so a retried request can never drift a stored result.
    assert.deepEqual(gradeObjectiveAnswers(input), result);

    // Time used comes from the server stamps and clamps to the attempt window.
    const used = computeTimeUsedSeconds({
      startedAtMs: ms(SERVER_START),
      endedAtMs: ms("2026-02-01T09:20:00Z"),
      maxSeconds: (expiresAtMs - ms(SERVER_START)) / 1000,
    });
    assert.equal(used, 20 * 60);
    const laggy = computeTimeUsedSeconds({
      startedAtMs: ms(SERVER_START),
      endedAtMs: ms("2026-02-01T12:00:00Z"),
      maxSeconds: (expiresAtMs - ms(SERVER_START)) / 1000,
    });
    assert.equal(laggy, DURATION_MINUTES * 60, "a lagged stamp never invents extra time");

    // Hand-off to the caller: the graded result is the ONLY score surface.
    gradedResult = result;
    timeUsedSeconds = used;
  });

  it("the after-window policy hides the result until the window closes", () => {
    assert.ok(gradedResult, "the previous stage produced a graded result");
    const visibilityBefore = studentResultVisibility({
      resultsRelease: "after_window",
      gradedAtMs: ms("2026-02-01T09:21:00Z"),
      windowEndsAtMs: ms(WINDOW_END),
      releasedAtMs: null,
      nowMs: ms("2026-02-01T09:30:00Z"),
    });
    assert.equal(visibilityBefore, "not_yet_released");
    assert.match(releaseHint("after_window"), /window/i);
    assert.equal(
      canRevealAnswers({
        resultsRelease: "after_window",
        gradedAtMs: ms("2026-02-01T09:21:00Z"),
        windowEndsAtMs: ms(WINDOW_END),
        releasedAtMs: null,
        nowMs: ms("2026-02-01T09:30:00Z"),
      }),
      false,
      "no answer keys leak while the window is still open",
    );

    const visibilityAfter = studentResultVisibility({
      resultsRelease: "after_window",
      gradedAtMs: ms("2026-02-01T09:21:00Z"),
      windowEndsAtMs: ms(WINDOW_END),
      releasedAtMs: null,
      nowMs: ms("2026-02-01T10:00:01Z"),
    });
    assert.equal(visibilityAfter, "released");
  });

  it("the released result renders consistently and only from stored facts", () => {
    assert.ok(gradedResult);
    const result = gradedResult!;
    assert.equal(formatPercentage(result.percentage), "60%");
    assert.equal(formatScore(result.totalScore, result.maxScore), "6 / 10");
    assert.equal(formatTimeUsed(timeUsedSeconds), "20m 00s");
    assert.equal(gradeForPercentage(result.percentage), "C");

    // The stored subject_breakdown jsonb is read defensively: a malformed
    // entry drops out rather than becoming a guessed row.
    const rows = buildSubjectRows(
      [
        { subjectId: SUBJECT_MATH, correct: 2, total: 4, score: 6, maxScore: 10 },
        { subjectId: 42, correct: 1, total: 1, score: 1, maxScore: 1 },
        null,
      ],
      (subjectId) => (subjectId === SUBJECT_MATH ? "Mathematics" : null),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subjectName, "Mathematics");
    assert.equal(rows[0].percentage, 60);
  });

  it("the teacher sees class analytics; the student sees only their own performance", () => {
    assert.ok(gradedResult);
    const adaRow: AnalyticsResultRow = {
      studentId: STUDENT_ADA.userId,
      studentName: "Ada Chukwu",
      percentage: gradedResult!.percentage,
      score: gradedResult!.totalScore,
      maxScore: gradedResult!.maxScore,
      correctCount: gradedResult!.correctCount,
      totalQuestions: gradedResult!.totalQuestions,
      topics: [{ topicId: "topic-algebra", topicName: "Algebra", correct: 1, total: 2 }],
      subjects: [{ subjectId: SUBJECT_MATH, subjectName: "Mathematics", score: 6, maxScore: 10 }],
      gradedAt: "2026-02-01T09:21:00.000Z",
      classId: CLASS_SS2,
      examId: "exam-1",
      examTitle: "SS2 Mathematics — Term 2 CBT",
    };
    const bolaRow: AnalyticsResultRow = {
      ...adaRow,
      studentId: STUDENT_BOLA.userId,
      studentName: "Bola Aminu",
      percentage: 80,
      score: 8,
      correctCount: 3,
    };

    const summary = computeClassSummary([adaRow, bolaRow], 3);
    assert.equal(summary.graded, 2);
    assert.equal(summary.average, 70);
    assert.equal(summary.highest, 80);
    assert.equal(summary.lowest, 60);
    assert.equal(summary.passed, 2);
    assert.equal(summary.notSubmitted, 1, "the roster is the honest denominator");

    const own = summarizeStudentPerformance([adaRow]);
    assert.equal(own.averagePercentage, 60);
    assert.equal(own.releasedResults, 1);
    assert.equal(own.confidence, "insufficient", "one test is flagged as a thin sample");

    // Permission posture: class analytics is a staff capability…
    const teacherRead = checkResourceAccess(
      { session: "active", principal: TEACHER_A },
      { permission: "analytics.read_class", operation: "read", resource: { kind: "analytics", institutionId: INST_A, classId: CLASS_SS2 }, callerScope: { teachingClassIds: [CLASS_SS2] } },
    );
    assert.equal(teacherRead.allowed, true);
    // …a student may only ever reach their OWN rows…
    const studentClassRead = checkResourceAccess(
      { session: "active", principal: STUDENT_ADA },
      { permission: "analytics.read_class", operation: "read", resource: { kind: "analytics", institutionId: INST_A } },
    );
    assert.equal(studentClassRead.allowed, false);
    if (studentClassRead.allowed === false) assert.equal(studentClassRead.reason, "permissionDenied");
    // …and the same-tenant peer's result is an owner mismatch, not a read.
    const peerResult = checkResourceAccess(
      { session: "active", principal: STUDENT_ADA },
      { permission: "result.read_own", operation: "read", resource: { kind: "result", institutionId: INST_A, ownerId: STUDENT_BOLA.userId, requiresOwner: true } },
    );
    assert.equal(peerResult.allowed, false);
    if (peerResult.allowed === false) assert.equal(peerResult.reason, "ownerMismatch");
  });
});

// --- Boundaries · roles, tenancy, and the answer key --------------------------

describe("critical workflow boundaries — role permissions and cross-tenant denial", () => {
  it("refuses non-identities before they ever reach a record", () => {
    const anonymous = decideAccess({ session: "anonymous", principal: null }, {});
    assert.equal(anonymous.allowed, false);
    if (anonymous.allowed === false) assert.equal(anonymous.reason, "signedOut");

    const expired = decideAccess({ session: "expired", principal: STUDENT_ADA }, {});
    assert.equal(expired.allowed, false);
    if (expired.allowed === false) assert.equal(expired.reason, "sessionExpired");

    // Signed in but no trusted role/tenant assigned yet — fails closed.
    const unassigned = readTrustedPrincipal({ userId: "user-new", privateMetadata: {} });
    assert.ok(unassigned);
    assert.equal(unassigned.hasMembership, false);
    const noMember = decideAccess({ session: "active", principal: unassigned }, {});
    assert.equal(noMember.allowed, false);
    if (noMember.allowed === false) assert.equal(noMember.reason, "noMembership");

    // A role with no tenant can never be a tenant member.
    const orphan = readTrustedPrincipal({
      userId: "user-orphan",
      privateMetadata: { role: "STUDENT", institutionId: "" },
    });
    assert.ok(orphan);
    assert.equal(orphan.hasMembership, false);
  });

  it("one institution can never read or write another institution's records", () => {
    // Rival teacher has the RIGHT permission and the WRONG tenant: the tenant
    // comparison denies, and denies before confirming anything about the row.
    const rivalExamRead = checkResourceAccess(
      { session: "active", principal: TEACHER_B },
      { permission: "exam.read_assigned", operation: "read", resource: { kind: "exam", institutionId: INST_A } },
    );
    assert.equal(rivalExamRead.allowed, false);
    if (rivalExamRead.allowed === false) assert.equal(rivalExamRead.reason, "tenantMismatch");

    // Page-level routing honours the same boundary.
    const rivalPage = decideAccess(
      { session: "active", principal: TEACHER_B },
      { roles: ["TEACHER"], institutionId: INST_A },
    );
    assert.equal(rivalPage.allowed, false);
    if (rivalPage.allowed === false) assert.equal(rivalPage.reason, "tenantMismatch");

    // A student of tenant B cannot even list tenant A's published exam.
    const rivalStudent = principalFor("user-eve", "STUDENT", INST_B);
    const rivalExamList = checkResourceAccess(
      { session: "active", principal: rivalStudent },
      { permission: "exam.read_assigned", operation: "read", resource: { kind: "exam", institutionId: INST_A } },
    );
    assert.equal(rivalExamList.allowed, false);
  });

  it("SUPER_ADMIN holds zero tenant permissions — platform rights are not tenant rights", () => {
    const decision = checkResourceAccess(
      { session: "active", principal: SUPER_ADMIN },
      { permission: "exam.read_assigned", operation: "read", resource: { kind: "exam", institutionId: INST_A } },
    );
    assert.equal(decision.allowed, false);
    if (decision.allowed === false) assert.equal(decision.reason, "permissionDenied");
    assert.equal(hasPermission(SUPER_ADMIN.role, "platform.audit"), true);
    assert.equal(hasPermission(SUPER_ADMIN.role, "member.manage"), false);
    assert.equal(hasPermission(SUPER_ADMIN.role, "result.read_class"), false);
  });

  it("least privilege inside the tenant: scope, ownership, and destructive ops", () => {
    // Teachers work only inside their ASSIGNED classes (prompt 13 scope).
    const outsideScope = checkResourceAccess(
      { session: "active", principal: TEACHER_A },
      { permission: "class.read_assigned", operation: "read", resource: { kind: "class", institutionId: INST_A, classId: "class-ss3-eagle" }, callerScope: { teachingClassIds: [CLASS_SS2] } },
    );
    assert.equal(outsideScope.allowed, false);
    if (outsideScope.allowed === false) assert.equal(outsideScope.reason, "scopeMismatch");
    // An absent scope list means "teaches nothing" — fail closed, not open.
    const noScope = checkResourceAccess(
      { session: "active", principal: TEACHER_A },
      { permission: "class.read_assigned", operation: "read", resource: { kind: "class", institutionId: INST_A, classId: CLASS_SS2 } },
    );
    assert.equal(noScope.allowed, false);

    // Delete is reserved for institution admins; teachers create and edit, never destroy.
    const teacherDelete = checkResourceAccess(
      { session: "active", principal: TEACHER_A },
      { permission: "exam.manage", operation: "delete", resource: { kind: "exam", institutionId: INST_A } },
    );
    assert.equal(teacherDelete.allowed, false);
    if (teacherDelete.allowed === false) assert.equal(teacherDelete.reason, "permissionDenied");
    const adminDelete = checkResourceAccess(
      { session: "active", principal: ADMIN_A },
      { permission: "exam.manage", operation: "delete", resource: { kind: "exam", institutionId: INST_A } },
    );
    assert.equal(adminDelete.allowed, true);

    // Students hold only own-scope reads — managing anything is denied.
    for (const permission of ["exam.manage", "question.manage", "member.manage"] as const) {
      assert.equal(hasPermission(STUDENT_ADA.role, permission), false);
    }
  });

  it("the answer key stays concealed until the server releases it", () => {
    const record = {
      id: "q-1",
      questionText: "Solve for x: 2x + 6 = 14.",
      options: ["2", "4", "6", "8"],
      correctOptionIndex: 1,
      explanation: "Subtract 6, divide by 2.",
    };

    // A student never sees the key, released or not — the reader-role gate.
    const studentView = redactRestrictedFields(record, STUDENT_ADA, { answerKeyReleased: true });
    assert.equal("correctOptionIndex" in studentView, false);
    assert.equal("answerKey" in studentView, false);
    assert.equal(canViewAnswerKey(STUDENT_ADA, { answerKeyReleased: true }), false);

    // Staff see it only once the record is server-side released.
    const unreleased = redactRestrictedFields(record, TEACHER_A, { answerKeyReleased: false });
    assert.equal("correctOptionIndex" in unreleased, false);
    const released = redactRestrictedFields(record, TEACHER_A, { answerKeyReleased: true });
    assert.equal("correctOptionIndex" in released, true);
    assert.equal(canViewAnswerKey(TEACHER_A, { answerKeyReleased: true }), true);

    // A student request that LIES about release changes nothing: policy is
    // judged from the loaded record, and the raw score gates stay server-side.
    assert.equal(
      isResultReleased({
        resultsRelease: "manual",
        gradedAtMs: ms("2026-02-01T09:21:00Z"),
        windowEndsAtMs: ms(WINDOW_END),
        releasedAtMs: null,
        nowMs: ms("2027-01-01T00:00:00Z"),
      }),
      false,
      "manual never self-releases with the clock",
    );
  });
});

// --- Edge cases · scheduling, expiry, recovery, idempotency, grading ---------

describe("critical workflow edges — unavailable, scheduled, expired, and degenerate data", () => {
  it("draft/scheduled/closed exams and revoked assignments are all unreachable for a student", () => {
    const now = at("2026-02-01T09:00:00Z");
    const base = {
      assignmentActive: true,
      startsAt: WINDOW_START,
      endsAt: WINDOW_END,
      attemptsUsed: 0,
      maxAttempts: 2,
      now,
    };
    assert.equal(studentExamEligibility({ ...base, status: "draft" }).state, "unavailable");
    assert.equal(studentExamEligibility({ ...base, status: "scheduled" }).state, "unavailable");
    assert.equal(studentExamEligibility({ ...base, status: "archived" }).state, "unavailable");
    // A closed exam stays in history but is never startable, window or not.
    const closed = studentExamStartGate({ ...base, status: "closed" });
    assert.equal(closed.allowed, false);
    // Assignment revoked mid-flight locks the door immediately.
    const revoked = studentExamStartGate({
      status: "published",
      assignmentActive: false,
      startsAt: WINDOW_START,
      endsAt: WINDOW_END,
      attemptsUsed: 0,
      maxAttempts: 2,
      now,
    });
    assert.equal(revoked.allowed, false);
    if (revoked.allowed === false) assert.match(revoked.message, /not assigned to you/i);

    // Published but past its window: expired, and start says so.
    const past = studentExamStartGate({
      status: "published",
      assignmentActive: true,
      startsAt: WINDOW_START,
      endsAt: WINDOW_END,
      attemptsUsed: 0,
      maxAttempts: 2,
      now: at("2026-02-02T09:00:00Z"),
    });
    assert.equal(past.allowed, false);
    if (past.allowed === false) assert.match(past.message, /window has ended/i);
    assert.equal(
      examIsAvailableToStudent({ status: "published", assignmentActive: true, startsAt: WINDOW_START, endsAt: WINDOW_END, now: at("2026-02-02T09:00:00Z") }),
      false,
    );

    // The attempt budget caps starts even inside an open window.
    const spent = studentExamStartGate({
      status: "published",
      assignmentActive: true,
      startsAt: WINDOW_START,
      endsAt: WINDOW_END,
      attemptsUsed: 2,
      maxAttempts: 2,
      now,
    });
    assert.equal(spent.allowed, false);
    if (spent.allowed === false) assert.match(spent.message, /all the attempts/i);
  });

  it("timer expiry auto-expires the attempt and locks saves", () => {
    // A student who started at 09:45 inside a 10:00 window is capped there.
    const expires = computeAttemptExpiresAt({
      startedAtMs: ms("2026-02-01T09:45:00Z"),
      durationMinutes: DURATION_MINUTES,
      examEndsAtMs: ms(WINDOW_END),
    });
    assert.equal(expires, ms(WINDOW_END));

    // Past the deadline, saves are refused even from a stale tab…
    assert.equal(canAcceptAnswer({ status: "in_progress", expiresAtMs: expires, nowMs: ms("2026-02-01T10:00:00Z") }), false);
    // …and a late submit records `expired`, not `submitted` — the server
    // clock judged the expiry first (AGENTS.md §6).
    const submit = attemptSubmitDecision({ status: "in_progress", expiresAtMs: expires, nowMs: ms("2026-02-01T10:00:05Z") });
    assert.deepEqual(submit, { outcome: "expired", next: "expired" });
    const second = attemptSubmitDecision({ status: "expired", expiresAtMs: expires, nowMs: ms("2026-02-01T10:00:10Z") });
    assert.deepEqual(second, { outcome: "already_expired" });

    // The countdown clamps at zero and never renders negative.
    assert.equal(attemptTimeRemainingMs(expires, ms("2026-02-01T11:00:00Z")), 0);
    assert.equal(formatCountdown(-5000), "0:00");
    assert.equal(formatCountdown(3_600_000 + 1_000), "1:00:01");
  });

  it("malformed answer selections are refused instead of stored", () => {
    const order = [2, 0, 3, 1];
    assert.equal(displayToCanonical(order, 4), null, "out of range");
    assert.equal(displayToCanonical(order, -1), null);
    assert.equal(displayToCanonical(order, 1.5), null, "fractional indices lie");
    assert.equal(displayToCanonical(order, 0), 2);
    assert.equal(canonicalToDisplay(order, 7), null, "a key that is not in the permutation");
  });

  it("degenerate grading inputs produce valid, comparable numbers — never NaN", () => {
    const empty = gradeObjectiveAnswers([]);
    assert.equal(empty.percentage, 0);
    assert.equal(empty.totalQuestions, 0);
    assert.deepEqual(empty.subjectBreakdown, []);

    // Zero/negative/NaN marks normalise to 0 rather than poisoning the total.
    const messy = gradeObjectiveAnswers([
      { snapshotId: "s1", marks: 0, correctOptionIndex: 0, selectedOptionIndex: 0, subjectId: SUBJECT_MATH },
      { snapshotId: "s2", marks: Number.NaN, correctOptionIndex: 0, selectedOptionIndex: 1, subjectId: "" },
    ]);
    assert.equal(messy.maxScore, 0);
    assert.equal(messy.percentage, 0, "no denominator, no fake percentage");
    assert.equal(messy.correctCount, 1);
    assert.equal(messy.incorrectCount, 1);
    assert.equal(messy.subjectBreakdown.length, 1, 'an empty subjectId drops out — it is never guessed');

    // A blank is never correct, and rounding is stable at the hundredth.
    assert.equal(
      gradeObjectiveAnswers([
        { snapshotId: "s1", marks: 1, correctOptionIndex: 0, selectedOptionIndex: null, subjectId: SUBJECT_MATH },
      ]).correctCount,
      0,
    );
    assert.equal(roundPercentage(2, 3), 66.67);
    assert.equal(roundPercentage(0, 0), 0);
    assert.equal(roundPercentage(Number.NaN, 10), 0);
  });

  it("an ungraded result is invisible under every release policy", () => {
    for (const resultsRelease of ["immediate", "after_window", "manual"] as const) {
      assert.equal(
        isResultReleased({ resultsRelease, gradedAtMs: null, windowEndsAtMs: null, releasedAtMs: null, nowMs: ms("2026-02-02T00:00:00Z") }),
        false,
        `${resultsRelease}: nothing to show before grading lands`,
      );
      assert.equal(
        studentResultVisibility({ resultsRelease, gradedAtMs: null, windowEndsAtMs: null, releasedAtMs: null, nowMs: ms("2026-02-02T00:00:00Z") }),
        "not_yet_released",
      );
    }
    // immediate releases on grade; unscheduled after_window falls back to on-grade.
    assert.equal(
      isResultReleased({ resultsRelease: "immediate", gradedAtMs: ms("2026-02-01T09:21:00Z"), windowEndsAtMs: ms(WINDOW_END), releasedAtMs: null, nowMs: ms("2026-02-01T09:22:00Z") }),
      true,
    );
    assert.equal(
      isResultReleased({ resultsRelease: "after_window", gradedAtMs: ms("2026-02-01T09:21:00Z"), windowEndsAtMs: null, releasedAtMs: null, nowMs: ms("2026-02-01T09:22:00Z") }),
      true,
    );
  });

  it("the lifecycle refuses illegal moves on both sides of the boundary", () => {
    assert.equal(canTransitionExam("published", "archived"), false, "published must close first");
    assert.equal(canTransitionExam("closed", "published"), false);
    assert.equal(canTransitionExam("archived", "draft"), false, "archived is terminal");
    assert.equal(
      examPublishBlocker("published", 4, 3, WINDOW_END, at(WINDOW_START)),
      "Only a draft or scheduled exam can be published.",
      "re-publish is refused",
    );

    assert.equal(
      JSON.stringify(
        gradeObjectiveAnswers([
          { snapshotId: "s", marks: 1, correctOptionIndex: 0, selectedOptionIndex: 0, subjectId: SUBJECT_MATH },
        ]),
      ).includes("correctOptionIndex"),
      false,
      "a computed result never carries an answer key forward",
    );
  });
});
