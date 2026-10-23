/**
 * Product-analytics contract tests — prompt 36 (pure layer only).
 *
 * Node built-in runner, the same convention as the rest of the suite: no
 * provider, no Supabase, no Next. The server-only dispatcher
 * (lib/product-analytics/server.ts) imports `server-only` and therefore
 * CANNOT be exercised in this runner — its behaviour (no-op default, never
 * throws, once-gate dedup) is a thin wrapper over the pure rules pinned
 * here, plus the same non-throwing posture already proven for the audit
 * writer by code review. What this file pins is the privacy/consent
 * boundary itself: the catalog, the per-event allowlists, the denylist that
 * refuses personal data and answer content whatever a call site passes,
 * value bounds, and the bounded once-only gate that keeps autosave/retry
 * replays from duplicating events.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRODUCT_ANALYTICS_EVENTS,
  buildProductAnalyticsEvent,
  createOnceGate,
  isProductAnalyticsEventName,
  propertyKeysFor,
} from "../../lib/product-analytics.ts";

/** Property list → key→value map, for readable assertions. */
function props(event: { properties: readonly { key: string; value: unknown }[] }) {
  return Object.fromEntries(event.properties.map((p) => [p.key, p.value]));
}

// --- The catalog --------------------------------------------------------------

describe("event catalog", () => {
  it("contains the eleven documented lifecycle events, snake_case", () => {
    assert.deepEqual([...PRODUCT_ANALYTICS_EVENTS].sort(), [
      "answer_saved",
      "assessment_completed",
      "exam_created",
      "exam_published",
      "exam_started",
      "exam_submitted",
      "institution_created",
      "question_created",
      "result_generated",
      "student_added",
      "teacher_invited",
    ]);
    for (const name of PRODUCT_ANALYTICS_EVENTS) {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
    }
  });

  it("refuses an unknown event name outright", () => {
    assert.equal(
      buildProductAnalyticsEvent({ name: "exam_deleted", properties: { examId: "e1" } }),
      null,
    );
    assert.equal(buildProductAnalyticsEvent({ name: "" }), null);
    assert.equal(buildProductAnalyticsEvent({ name: 42 as unknown as string }), null);
    assert.equal(isProductAnalyticsEventName("answer_saved"), true);
    assert.equal(isProductAnalyticsEventName("Answer_Saved"), false);
  });

  it("accepts every catalogued event with its required properties", () => {
    const requiredOnly: Record<string, Record<string, unknown>> = {
      institution_created: {},
      teacher_invited: {},
      student_added: {},
      question_created: { questionId: "q1" },
      exam_created: { examId: "e1" },
      exam_published: { examId: "e1" },
      exam_started: { examId: "e1" },
      answer_saved: {},
      exam_submitted: { attemptId: "a1" },
      result_generated: {},
      assessment_completed: { attemptId: "a1" },
    };
    for (const name of PRODUCT_ANALYTICS_EVENTS) {
      const event = buildProductAnalyticsEvent({
        name,
        properties: requiredOnly[name],
        institutionId: "inst-1",
      });
      assert.notEqual(event, null, `${name} should build`);
      assert.equal(event!.name, name);
    }
  });
});

// --- Allowlist: undocumented keys never travel --------------------------------

describe("per-event property allowlist", () => {
  it("silently drops a key the event does not document", () => {
    const event = buildProductAnalyticsEvent({
      name: "exam_created",
      properties: { examId: "e1", planTier: "enterprise", seatCount: 50 },
    });
    assert.ok(event);
    assert.deepEqual(props(event), { examId: "e1" });
  });

  it("documents only non-sensitive ids, roles, types and counts", () => {
    // The full catalog surface, pinned: no key may smell like personal data
    // or content. If someone widens an allowlist later, this test forces a
    // conscious edit + review rather than a silent drift.
    const sensitive = /email|phone|password|token|secret|name|text|content|answer|option|key|address|ip$/i;
    for (const name of PRODUCT_ANALYTICS_EVENTS) {
      for (const key of propertyKeysFor(name)) {
        assert.ok(!sensitive.test(key), `${name}.${key} looks sensitive`);
      }
    }
  });
});

// --- Denylist: privacy holds even against a widened allowlist ------------------

describe("privacy denylist", () => {
  it("refuses personal/content values smuggled as extra keys", () => {
    // A call site (or a future careless adapter) must never ship question
    // text, answers, names or secrets — every one of these is dropped here.
    const event = buildProductAnalyticsEvent({
      name: "question_created",
      properties: {
        questionId: "q1",
        questionText: "What is the capital of France?",
        correctAnswer: "Paris",
        answerKey: "B",
        studentName: "Aisha Bello",
        email: "a@example.com",
        phone: "08012345678",
        password: "hunter2",
        accessToken: "sk_live_...",
        selectedOptionIndex: 2,
        options: ["Paris", "London"],
        ip: "10.0.0.1",
      },
    });
    assert.ok(event);
    assert.deepEqual(props(event), { questionId: "q1" });
    const shipped = JSON.stringify(event);
    for (const leak of ["Paris", "Aisha", "hunter2", "sk_live", "08012345678", "a@example.com"]) {
      assert.ok(!shipped.includes(leak), `event leaked ${leak}`);
    }
  });
});

// --- Closed vocabularies --------------------------------------------------------

describe("enum-guarded properties", () => {
  it("accepts catalogued values and drops anything outside the vocabulary", () => {
    const ok = buildProductAnalyticsEvent({
      name: "question_created",
      properties: { questionId: "q1", difficulty: "hard", questionType: "multiple_choice", role: "TEACHER" },
    });
    assert.ok(ok);
    assert.deepEqual(props(ok), { questionId: "q1", difficulty: "hard", questionType: "multiple_choice", role: "TEACHER" });

    const bad = buildProductAnalyticsEvent({
      name: "question_created",
      properties: { questionId: "q2", difficulty: "impossible", questionType: "essay", role: "SUPERUSER" },
    });
    assert.ok(bad);
    assert.deepEqual(props(bad), { questionId: "q2" });
  });

  it("guards institution type and submission method the same way", () => {
    const institution = buildProductAnalyticsEvent({
      name: "institution_created",
      properties: { institutionType: "tutorial_centre", role: "SUPER_ADMIN" },
    });
    assert.ok(institution);
    assert.deepEqual(props(institution), { institutionType: "tutorial_centre", role: "SUPER_ADMIN" });

    const bogus = buildProductAnalyticsEvent({
      name: "institution_created",
      properties: { institutionType: "university" },
    });
    assert.ok(bogus);
    assert.deepEqual(props(bogus), {});

    const submitted = buildProductAnalyticsEvent({
      name: "exam_submitted",
      properties: { attemptId: "a1", submissionMethod: "auto_forced" },
    });
    assert.ok(submitted);
    assert.deepEqual(props(submitted), { attemptId: "a1" });
  });
});

// --- Required properties refuse malformed events ----------------------------------

describe("required properties", () => {
  it("refuses the whole event when a required id is absent or unusable", () => {
    assert.equal(buildProductAnalyticsEvent({ name: "question_created", properties: {} }), null);
    assert.equal(
      buildProductAnalyticsEvent({ name: "question_created", properties: { questionId: null } }),
      null,
    );
    assert.equal(
      buildProductAnalyticsEvent({ name: "question_created", properties: { questionId: { id: 1 } } }),
      null,
    );
    assert.equal(buildProductAnalyticsEvent({ name: "exam_published", properties: {} }), null);
    assert.equal(buildProductAnalyticsEvent({ name: "assessment_completed", properties: { attemptId: "  " } }), null);
  });

  it("drops an optional property that is empty, not a refusal", () => {
    const event = buildProductAnalyticsEvent({
      name: "student_added",
      properties: { studentId: "s1", classId: "" },
    });
    assert.ok(event);
    assert.deepEqual(props(event), { studentId: "s1" });
  });
});

// --- Value bounds ----------------------------------------------------------------

describe("value bounds", () => {
  it("trims strings and caps over-long ones", () => {
    const event = buildProductAnalyticsEvent({
      name: "exam_created",
      properties: { examId: "  e1  ", examCategory: "x".repeat(500) },
    });
    assert.ok(event);
    const built = props(event);
    assert.equal(built.examId, "e1");
    assert.equal((built.examCategory as string).length, 120);
  });

  it("drops non-finite numbers and non-primitive values", () => {
    const event = buildProductAnalyticsEvent({
      name: "result_generated",
      properties: {
        percentage: Number.NaN,
        released: true,
        subjectBreakdown: { math: 0.5 },
        topics: ["algebra"],
        gradedAt: "2026-10-22T10:00:00.000Z",
      },
    });
    assert.ok(event);
    assert.deepEqual(props(event), { released: true, gradedAt: "2026-10-22T10:00:00.000Z" });
  });

  it("keeps booleans and zero numbers (both are meaningful values)", () => {
    const event = buildProductAnalyticsEvent({
      name: "exam_published",
      properties: { examId: "e1", audienceSize: 0, role: null },
    });
    assert.ok(event);
    assert.deepEqual(props(event), { examId: "e1", audienceSize: 0 });
  });
});

// --- Tenant grouping key ---------------------------------------------------------

describe("institutionId grouping key", () => {
  it("travels outside the property payload", () => {
    const event = buildProductAnalyticsEvent({
      name: "student_added",
      properties: { studentId: "s1" },
      institutionId: " inst-9 ",
    });
    assert.ok(event);
    assert.equal(event.institutionId, "inst-9");
    assert.ok(!event.properties.some((p) => p.key === "institutionId"));
  });

  it("degrades to null for blank, oversized, or non-string values", () => {
    for (const bad of ["", "   ", "x".repeat(65), 7 as unknown as string, undefined]) {
      const event = buildProductAnalyticsEvent({
        name: "result_generated",
        properties: {},
        institutionId: bad as string | null | undefined,
      });
      assert.ok(event);
      assert.equal(event.institutionId, null);
    }
  });
});

// --- Timestamps -------------------------------------------------------------------

describe("occurredAt stamping", () => {
  it("normalises a parseable stamp to ISO and falls back to server now", () => {
    const stamped = buildProductAnalyticsEvent({
      name: "answer_saved",
      properties: {},
      occurredAt: "2026-03-01T08:30:00Z",
    });
    assert.ok(stamped);
    assert.equal(stamped.occurredAt, "2026-03-01T08:30:00.000Z");

    const before = Date.now();
    const fallback = buildProductAnalyticsEvent({ name: "answer_saved", occurredAt: "not a date" });
    assert.ok(fallback);
    const ms = Date.parse(fallback.occurredAt);
    assert.ok(ms >= before && ms <= Date.now() + 1000);
  });
});

// --- The bounded once-only gate -----------------------------------------------------

describe("createOnceGate", () => {
  it("claims a key exactly once and refuses replays", () => {
    const gate = createOnceGate();
    assert.equal(gate.claim("attempt-1"), true);
    assert.equal(gate.claim("attempt-1"), false);
    assert.equal(gate.claim("attempt-2"), true);
    assert.equal(gate.size(), 2);
  });

  it("refuses blank keys without remembering them", () => {
    const gate = createOnceGate();
    assert.equal(gate.claim(""), false);
    assert.equal(gate.claim("   "), false);
    assert.equal(gate.size(), 0);
  });

  it("stays bounded: past the cap it resets rather than growing forever", () => {
    const gate = createOnceGate(3);
    assert.equal(gate.claim("a"), true);
    assert.equal(gate.claim("b"), true);
    assert.equal(gate.claim("c"), true);
    // Fourth claim trips the cap → wholesale reset, then the key is recorded.
    assert.equal(gate.claim("d"), true);
    assert.equal(gate.size(), 1);
    // The cost of bounded memory: an old key may reclaim. The DB CAS guards
    // remain the real dedup — this is documented behaviour, not a surprise.
    assert.equal(gate.claim("a"), true);
  });

  it("uses the documented default cap when none is given", () => {
    const gate = createOnceGate();
    for (let i = 0; i < 5000; i++) gate.claim(`key-${i}`);
    assert.equal(gate.size(), 5000);
    gate.claim("overflow"); // trips the cap → reset → single entry
    assert.equal(gate.size(), 1);
  });
});
