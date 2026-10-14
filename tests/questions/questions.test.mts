/**
 * Question bank tests — prompt 15.
 *
 * Two classes of coverage, both on pure code the app actually runs:
 *   1. structural validation + normalisation + list-query safety
 *      (lib/questions.ts) — the same functions the browser form and the server
 *      actions share. The answer-key integrity rule (the correct index must map
 *      to a real option) lives here and is pinned explicitly.
 *   2. the question.manage / question.read_answer_key permission + the tenant
 *      and delete-privilege boundary the flows rely on. NOTE ON WHAT THE FLOW
 *      CALLS: the question pages and server actions authorize with
 *      `requireRole(["TEACHER","INSTITUTION_ADMIN"])` and scope every query by
 *      the trusted `principal.institutionId`; the finer `checkResourceAccess()`
 *      engine (kind "question") is exercised here as the reference boundary —
 *      including that a TEACHER may manage questions but NEVER delete them
 *      (AGENTS.md §5, §6).
 *
 * The Supabase data layer itself is NOT exercised here — there is no live DB in
 * `npm test`. Its guarantees (status/type/difficulty CHECKs, the option array
 * shape, the topic→subject anchor trigger, cross-tenant id handling, deployed
 * RLS that hides the answer key from browser roles) are covered by the runnable
 * SQL harness in supabase/tests/, which needs a real database.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeQuestionInput,
  optionLabel,
  questionMeaningChanged,
  QUESTION_INPUT_EMPTY,
  QUESTION_PAGE_SIZE,
  questionPageHref,
  resolveQuestionListQuery,
  validateQuestion,
  type QuestionInput,
} from "../../lib/questions.ts";
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

/** A structurally valid MCQ; override fields per case. */
function questionInput(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    ...QUESTION_INPUT_EMPTY,
    questionText: "What is 2 + 2?",
    subjectId: "subj-1",
    options: ["2", "3", "4", "5"],
    correctOptionIndex: 2,
    ...overrides,
  };
}

// --- Question validation -----------------------------------------------------

describe("validateQuestion", () => {
  it("accepts a well-formed single-answer MCQ", () => {
    assert.deepEqual(validateQuestion(questionInput()), {});
  });

  it("requires non-empty question text and a subject", () => {
    const errors = validateQuestion(
      questionInput({ questionText: "   ", subjectId: "" }),
    );
    assert.ok(errors.questionText);
    assert.ok(errors.subjectId);
  });

  it("refuses a question type the MVP cannot grade", () => {
    const errors = validateQuestion(
      questionInput({ questionType: "multi_select" as QuestionInput["questionType"] }),
    );
    assert.ok(errors.questionType);
  });

  it("requires 2–8 options and rejects blank or duplicate choices", () => {
    assert.ok(validateQuestion(questionInput({ options: ["2"] })).options);
    assert.ok(
      validateQuestion(questionInput({ options: Array(9).fill(0).map((_, i) => String(i)) })).options,
    );
    assert.ok(validateQuestion(questionInput({ options: ["2", "  "] })).options);
    assert.ok(validateQuestion(questionInput({ options: ["2", "2"] })).options);
    // case/space-insensitive duplicate detection
    assert.ok(validateQuestion(questionInput({ options: [" Four ", "four"] })).options);
  });

  it("keeps the answer key bound to a real option", () => {
    // index past the end of the options array is rejected…
    assert.ok(
      validateQuestion(questionInput({ options: ["2", "3"], correctOptionIndex: 5 }))
        .correctOptionIndex,
    );
    // …and so is a non-integer or negative index.
    assert.ok(validateQuestion(questionInput({ correctOptionIndex: -1 })).correctOptionIndex);
    assert.ok(
      validateQuestion(questionInput({ correctOptionIndex: 1.5 })).correctOptionIndex,
    );
  });

  it("surfaces both problems when options AND key are invalid", () => {
    const errors = validateQuestion(
      questionInput({ options: ["", ""], correctOptionIndex: 9 }),
    );
    assert.ok(errors.options);
    assert.ok(errors.correctOptionIndex);
  });

  it("bounds marks and validates the optional source year", () => {
    assert.ok(validateQuestion(questionInput({ marks: 0 })).marks);
    assert.ok(validateQuestion(questionInput({ marks: 51 })).marks);
    assert.ok(validateQuestion(questionInput({ sourceYear: "1800" })).sourceYear);
    assert.ok(validateQuestion(questionInput({ sourceYear: "abc" })).sourceYear);
    // empty year is allowed (unset)
    assert.equal(validateQuestion(questionInput({ sourceYear: "  " })).sourceYear, undefined);
  });

  it("requires a known provenance value", () => {
    assert.ok(
      validateQuestion(
        questionInput({ provenance: "scraped" as QuestionInput["provenance"] }),
      ).provenance,
    );
  });
});

// --- Normalisation -----------------------------------------------------------

describe("normalizeQuestionInput", () => {
  it("trims text, options, and metadata without touching the answer index", () => {
    const normalized = normalizeQuestionInput(
      questionInput({
        questionText: "  Solve for x  ",
        options: ["  1 ", "2  "],
        correctOptionIndex: 1,
        sourceYear: " 2019 ",
        explanation: "  because  ",
      }),
    );
    assert.equal(normalized.questionText, "Solve for x");
    assert.deepEqual(normalized.options, ["1", "2"]);
    assert.equal(normalized.correctOptionIndex, 1);
    assert.equal(normalized.sourceYear, "2019");
    assert.equal(normalized.explanation, "because");
  });
});

// --- Option labels ------------------------------------------------------------

describe("optionLabel", () => {
  it("maps a 0-based index to an A/B/C… letter", () => {
    assert.equal(optionLabel(0), "A");
    assert.equal(optionLabel(1), "B");
    assert.equal(optionLabel(7), "H");
  });
});

// --- Edit safety: which changes are meaning-changing (prompt 16) --------------

describe("questionMeaningChanged", () => {
  /** The stored content a form edit is compared against. */
  function stored(overrides: Partial<QuestionInput> = {}): QuestionInput {
    return questionInput(overrides);
  }

  it("treats an unchanged payload as no meaning change", () => {
    const current = stored();
    assert.equal(questionMeaningChanged(current, current), false);
  });

  it("detects wording, option-text, answer-key, marks, and type changes", () => {
    const current = stored();
    assert.equal(
      questionMeaningChanged(current, stored({ questionText: "What is 2+2 ?" })),
      true,
    );
    assert.equal(
      questionMeaningChanged(current, stored({ options: ["2", "3", "4", "six"] })),
      true,
    );
    assert.equal(
      questionMeaningChanged(current, stored({ correctOptionIndex: 1 })),
      true,
    );
    assert.equal(questionMeaningChanged(current, stored({ marks: 2 })), true);
    assert.equal(
      questionMeaningChanged(current, stored({ questionType: "true_false" as QuestionInput["questionType"] })),
      true,
    );
  });

  it("detects adding or removing an option", () => {
    const current = stored({ options: ["2", "3", "4"] });
    assert.equal(
      questionMeaningChanged(current, stored({ options: ["2", "3", "4", "5"] })),
      true,
    );
    assert.equal(
      questionMeaningChanged(current, stored({ options: ["2", "3"] })),
      true,
    );
  });

  it("ignores surrounding whitespace — stored values are trimmed", () => {
    const current = stored({ questionText: "What is 2 + 2?", options: ["2", "3", "4", "5"] });
    assert.equal(
      questionMeaningChanged(current, stored({ questionText: "  What is 2 + 2? " })),
      false,
    );
    assert.equal(
      questionMeaningChanged(current, stored({ options: ["2", "3", " 4 ", "5"] })),
      false,
    );
  });

  it("metadata-only edits never create a version", () => {
    const current = stored();
    assert.equal(
      questionMeaningChanged(
        current,
        stored({
          explanation: "Because addition.",
          learningObjective: "Arithmetic basics",
          provenance: "licensed",
          sourceLabel: "WAEC 2019",
          sourceYear: "2019",
          licenseNotes: "Used with permission",
          difficulty: "hard",
          subjectId: "subj-2",
          topicId: "topic-9",
          categoryId: "cat-3",
        }),
      ),
      false,
    );
  });
});

// --- List query resolution ---------------------------------------------------

describe("resolveQuestionListQuery", () => {
  it("returns safe defaults when the URL is empty", () => {
    assert.deepEqual(resolveQuestionListQuery({}), {
      q: "",
      subjectId: "",
      topicId: "",
      difficulty: null,
      status: null,
      mine: false,
      page: 1,
      pageSize: QUESTION_PAGE_SIZE,
    });
  });

  it("clamps hostile or stale values from the URL", () => {
    const query = resolveQuestionListQuery({
      q: "  algebra  ",
      difficulty: "impossible",
      status: "deleted",
      mine: "yes",
      page: "-4",
    });
    assert.equal(query.q, "algebra");
    assert.equal(query.difficulty, null); // unknown difficulty → all
    assert.equal(query.status, null); // unknown status → all
    assert.equal(query.mine, false); // "yes" is not a truthy facet token
    assert.equal(query.page, 1);
  });

  it("narrows to known difficulty/status and recognises the mine facet", () => {
    const query = resolveQuestionListQuery({ difficulty: "hard", status: "archived", mine: "1" });
    assert.equal(query.difficulty, "hard");
    assert.equal(query.status, "archived");
    assert.equal(query.mine, true);
  });

  it("length-bounds the search term and id filters", () => {
    const query = resolveQuestionListQuery({ q: "x".repeat(500), subject: "s".repeat(200) });
    assert.equal(query.q.length, 120);
    assert.equal(query.subjectId.length, 64);
  });

  it("takes the first value of repeated params", () => {
    assert.equal(resolveQuestionListQuery({ page: ["3", "9"] }).page, 3);
  });
});

describe("questionPageHref", () => {
  it("omits filters and page 1 from the URL", () => {
    const query = resolveQuestionListQuery({});
    assert.equal(questionPageHref("/teacher/questions", query, 1), "/teacher/questions");
  });

  it("preserves every active filter across pages", () => {
    const query = resolveQuestionListQuery({
      q: "algebra",
      subject: "subj-1",
      topic: "topic-1",
      difficulty: "hard",
      status: "archived",
      mine: "1",
    });
    assert.equal(
      questionPageHref("/teacher/questions", query, 2),
      "/teacher/questions?q=algebra&subject=subj-1&topic=topic-1&difficulty=hard&status=archived&mine=1&page=2",
    );
  });
});

// --- Permission catalog wiring ------------------------------------------------

describe("question.manage catalog entry", () => {
  it("is held by teachers and institution admins, never students/super-admin", () => {
    assert.equal(hasPermission("TEACHER", "question.manage"), true);
    assert.equal(hasPermission("INSTITUTION_ADMIN", "question.manage"), true);
    assert.equal(hasPermission("STUDENT", "question.manage"), false);
    assert.equal(hasPermission("SUPER_ADMIN", "question.manage"), false);
    assert.equal(hasPermission(null, "question.manage"), false);
  });
});

describe("question.read_answer_key catalog entry", () => {
  it("gates the key to the same manager roles only", () => {
    assert.equal(hasPermission("TEACHER", "question.read_answer_key"), true);
    assert.equal(hasPermission("INSTITUTION_ADMIN", "question.read_answer_key"), true);
    assert.equal(hasPermission("STUDENT", "question.read_answer_key"), false);
    assert.equal(hasPermission("SUPER_ADMIN", "question.read_answer_key"), false);
    assert.equal(hasPermission(null, "question.read_answer_key"), false);
  });
});

// --- Tenant + privilege boundary via the resource engine ---------------------

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

function questionRequest(
  permission: ResourceAccessRequest["permission"],
  operation: ResourceAccessRequest["operation"],
  overrides: Partial<ResourceDescriptor> = {},
): ResourceAccessRequest {
  return {
    permission,
    operation,
    resource: { kind: "question", institutionId: INSTITUTION_A, ...overrides },
  };
}

describe("question boundary", () => {
  it("grants a teacher read/update of a question in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("TEACHER", INSTITUTION_A), questionRequest("question.manage", "read")).allowed,
      true,
    );
    assert.equal(
      checkResourceAccess(signedIn("TEACHER", INSTITUTION_A), questionRequest("question.manage", "update")).allowed,
      true,
    );
  });

  it("grants an institution admin read/update in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), questionRequest("question.manage", "read")).allowed,
      true,
    );
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), questionRequest("question.manage", "update")).allowed,
      true,
    );
  });

  it("denies a teacher DELETING a question (archive is the only retirement)", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      questionRequest("question.manage", "delete"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("allows an institution admin to delete a question in their own tenant", () => {
    assert.equal(
      checkResourceAccess(signedIn("INSTITUTION_ADMIN", INSTITUTION_A), questionRequest("question.manage", "delete")).allowed,
      true,
    );
  });

  it("denies a student the question bank entirely", () => {
    const decision = checkResourceAccess(
      signedIn("STUDENT", INSTITUTION_A),
      questionRequest("question.manage", "read"),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "permissionDenied");
  });

  it("denies acting on another institution's question (cross-tenant)", () => {
    const decision = checkResourceAccess(
      signedIn("TEACHER", INSTITUTION_A),
      questionRequest("question.manage", "update", { institutionId: INSTITUTION_B }),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.reason, "tenantMismatch");
  });
});

// --- The tenant invariant the question actions rely on -----------------------
// Every question page and action does `principal.institutionId as string` after
// `requireRole(["TEACHER","INSTITUTION_ADMIN"])`. That cast is only sound
// because a manager with no usable tenant can NEVER be authorized. These tests
// pin that guarantee so the data layer never scopes to `null`.
describe("question flow tenant invariant (why the institutionId cast is safe)", () => {
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
