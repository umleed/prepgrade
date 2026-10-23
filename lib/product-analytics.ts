/**
 * Product-analytics event contracts — pure, dependency-free, unit-testable
 * (prompt 36).
 *
 * WHY THIS LAYER IS PROVIDER-AGNOSTIC
 * PrepGrade has NO analytics provider configured yet (no PostHog client, no
 * browser script, no project keys). The prompt's rule "do not initialise a
 * duplicate client" cuts both ways: nothing may be silently bootstrapped here,
 * and the product must not lock itself to a vendor either. So the tracked
 * moments are expressed as NORMALISED, PRIVACY-GUARDED events that the
 * server-only dispatcher (`lib/product-analytics/server.ts`) hands to whichever
 * adapter is registered — today a no-op, later possibly PostHog, without any
 * call site changing.
 *
 * THE THREE BOUNDARIES THIS MODULE ENFORCES (AGENTS.md §7, prompt 36)
 * 1. CATALOG, NOT FREESTYLE. Only the documented event names below are ever
 *    produced; an unknown name normalises to `null` and is dropped. Properties
 *    are allowlisted PER EVENT — an undocumented key never travels.
 * 2. NOTHING SENSITIVE LEAVES. Keys that smell like personal data or secrets
 *    (email, phone, name, password, token, question/answer text, answer keys)
 *    are refused by BOTH the per-event allowlist and the denylist, whatever the
 *    caller passes. `institutionId` is deliberately NOT a property: it travels
 *    as a separate grouping key for the adapter, so no provider ever receives
 *    tenant ids inside event payloads by accident.
 * 3. VALUES ARE BOUNDED. Strings are length-capped, numbers must be finite,
 *    closed vocabularies (roles, difficulty, submission method) are enum
 *    checked — a stray long text or NaN degrades to dropping that property,
 *    never to sending garbage.
 *
 * Analytics NEVER replaces authoritative database metrics (Implementation
 * Notes, prompt 36): everything here is a best-effort observational copy of a
 * lifecycle moment that the database already records authoritatively. A
 * tracking failure must not affect the product flow — the dispatcher upholds
 * that rule; this module only shapes the events.
 */

// --- Event names -------------------------------------------------------------

/** The stable, documented product events (snake_case, provider-agnostic). */
export const PRODUCT_ANALYTICS_EVENTS = [
  "institution_created",
  "teacher_invited",
  "student_added",
  "question_created",
  "exam_created",
  "exam_published",
  "exam_started",
  "answer_saved",
  "exam_submitted",
  "result_generated",
  "assessment_completed",
] as const;

export type ProductAnalyticsEventName = (typeof PRODUCT_ANALYTICS_EVENTS)[number];

export function isProductAnalyticsEventName(
  value: unknown,
): value is ProductAnalyticsEventName {
  return (
    typeof value === "string" &&
    (PRODUCT_ANALYTICS_EVENTS as readonly string[]).includes(value)
  );
}

// --- Property values ---------------------------------------------------------

/** A property value after normalisation: only primitives survive. */
export type ProductAnalyticsPropertyValue = string | number | boolean;

/** One normalised property: a validated key plus a bounded value. */
export type ProductAnalyticsProperty = {
  key: string;
  value: ProductAnalyticsPropertyValue;
};

/** The normalised event an adapter receives. `institutionId` is the tenant
 *  grouping key, NOT a payload property (see the header note). */
export type ProductAnalyticsEvent = {
  name: ProductAnalyticsEventName;
  occurredAt: string;
  institutionId: string | null;
  properties: ProductAnalyticsProperty[];
};

// --- Closed vocabularies -----------------------------------------------------
// Mirrors of the controlled lists the data layers already enforce, restated
// here so the analytics boundary does not depend on (or import) product
// modules. A value outside the list is dropped, never forwarded verbatim.

const ROLE_VALUES = ["SUPER_ADMIN", "INSTITUTION_ADMIN", "TEACHER", "STUDENT"];
const DIFFICULTY_VALUES = ["easy", "medium", "hard"];
const QUESTION_TYPE_VALUES = ["multiple_choice"];
const SUBMISSION_METHOD_VALUES = ["explicit", "expired"];
const INSTITUTION_TYPE_VALUES = ["school", "tutorial_centre", "cbt_centre"];

// --- Property specs ----------------------------------------------------------

type PropertySpec = {
  /** Required: an event missing this property is refused entirely, because
   *  the event would be unanalysable (e.g. no subject id). */
  required?: boolean;
  /** When set, only these exact strings survive (closed vocabularies). */
  enumValues?: readonly string[];
};

/**
 * The per-event property allowlists. These are the documented properties for
 * the catalog — the union of "non-sensitive IDs, institution type, role,
 * exam category" the prompt lists, and nothing else. Adding a property here
 * is a deliberate, reviewable act; the call sites cannot invent keys.
 */
const EVENT_PROPERTY_SPECS: Record<
  ProductAnalyticsEventName,
  Readonly<Record<string, PropertySpec>>
> = {
  institution_created: {
    // "institution type" is the documented dimension; `role` is the trusted
    // acting context (platform flows only — the data layer cannot know it).
    institutionType: { enumValues: INSTITUTION_TYPE_VALUES },
    role: { enumValues: ROLE_VALUES },
  },
  teacher_invited: {
    teacherId: {},
    role: { enumValues: ROLE_VALUES },
  },
  student_added: {
    studentId: {},
    classId: {},
    role: { enumValues: ROLE_VALUES },
  },
  question_created: {
    questionId: { required: true },
    difficulty: { enumValues: DIFFICULTY_VALUES },
    questionType: { enumValues: QUESTION_TYPE_VALUES },
    role: { enumValues: ROLE_VALUES },
  },
  exam_created: {
    examId: { required: true },
    examCategory: {},
    role: { enumValues: ROLE_VALUES },
  },
  exam_published: {
    examId: { required: true },
    examCategory: {},
    audienceSize: {},
    role: { enumValues: ROLE_VALUES },
  },
  exam_started: {
    examId: { required: true },
    attemptId: {},
    attemptNumber: {},
  },
  answer_saved: {
    // One event per attempt (the FIRST save), so the high-frequency autosave
    // write cannot flood the stream. Carries flags only — never the selected
    // option, question text, or answer key.
    attemptId: {},
    examId: {},
    markedForReview: {},
  },
  exam_submitted: {
    examId: {},
    attemptId: { required: true },
    submissionMethod: { enumValues: SUBMISSION_METHOD_VALUES },
    durationSeconds: {},
  },
  result_generated: {
    examId: {},
    attemptId: {},
    resultId: {},
    // Server-derived percentage from the authoritative grading engine — the
    // ONLY score that may travel, and it is descriptive, not personal.
    percentage: {},
    released: {},
    gradedAt: {},
  },
  assessment_completed: {
    examId: {},
    attemptId: { required: true },
    submissionMethod: { enumValues: SUBMISSION_METHOD_VALUES },
    durationSeconds: {},
  },
};

/** Documented property keys for one event (exported for tests and docs). */
export function propertyKeysFor(
  name: ProductAnalyticsEventName,
): readonly string[] {
  return Object.keys(EVENT_PROPERTY_SPECS[name]);
}

// --- Privacy guards ----------------------------------------------------------

/** Max length of a string property value (or an unlisted key's whole name). */
const MAX_STRING_LENGTH = 120;
const MAX_KEY_LENGTH = 40;
const MAX_INSTITUTION_ID_LENGTH = 64;

/**
 * Key-substring denylist. Even a correctly-named allowlisted property whose key
 * smells like personal data or a secret is refused — defence in depth against
 * someone widening an allowlist carelessly later. Matched case-insensitively.
 * "apikey" covers API keys; a bare "key" entry is deliberately NOT used — it
 * would swallow the documented non-sensitive ids (questionId, resultId).
 */
const DENY_KEY_PARTS = [
  "email",
  "phone",
  "password",
  "token",
  "secret",
  "apikey",
  "auth",
  "cookie",
  "name",
  "text",
  "content",
  "explanation",
  "answer",
  "option",
  "address",
  "ip",
] as const;

function isDeniedKey(key: string): boolean {
  const lower = key.toLowerCase();
  // "ip" is matched as a whole word only — it would otherwise eat harmless
  // keys; "attemptId"/"studentId" are the documented non-sensitive IDs.
  return DENY_KEY_PARTS.some((part) =>
    part === "ip" ? lower === "ip" : lower.includes(part),
  );
}

/** Property keys are camelCase identifiers (repo convention); snake_case
 *  segments are tolerated too, but nothing else — no spaces, dots, or braces. */
const VALID_KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(_[a-z0-9]+)*$/;

function isPrivateOrSensitiveKey(key: string): boolean {
  return key.length > MAX_KEY_LENGTH || !VALID_KEY_SHAPE.test(key) || isDeniedKey(key);
}

// --- Value normalisation -----------------------------------------------------

function normaliseStringValue(
  value: unknown,
  spec: PropertySpec,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (spec.enumValues) {
    return spec.enumValues.includes(trimmed) ? trimmed : null;
  }
  return trimmed.length > MAX_STRING_LENGTH
    ? trimmed.slice(0, MAX_STRING_LENGTH)
    : trimmed;
}

function normaliseValue(
  value: unknown,
  spec: PropertySpec,
): ProductAnalyticsPropertyValue | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") return normaliseStringValue(value, spec);
  // Objects, arrays, null, undefined, functions — never travel.
  return null;
}

function normaliseInstitutionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INSTITUTION_ID_LENGTH) {
    return null;
  }
  return trimmed;
}

// --- The one entry point -------------------------------------------------------

/**
 * Validate and normalise one tracking call into a shippable event, or `null`
 * when it must be dropped. A single rule violated (unknown event name, a
 * missing required property, a denied key, an unshippable value type) drops
 * THAT PROPERTY — except required properties, whose absence or invalidity
 * refuses the whole event so a malformed event never enters the stream.
 * Unknown-but-harmless extra keys the caller passed are silently discarded
 * (the allowlist is the contract); denied-looking keys are also discarded,
 * never "reported".
 */
export function buildProductAnalyticsEvent(input: {
  name: string;
  properties?: Record<string, unknown>;
  institutionId?: string | null;
  occurredAt?: string;
}): ProductAnalyticsEvent | null {
  if (!isProductAnalyticsEventName(input.name)) return null;

  const specs = EVENT_PROPERTY_SPECS[input.name];
  const incoming = input.properties ?? {};
  const properties: ProductAnalyticsProperty[] = [];

  for (const [key, spec] of Object.entries(specs)) {
    if (!(key in incoming)) {
      if (spec.required) return null; // unanalysable event — refuse it
      continue;
    }
    const value = incoming[key];
    if (value === undefined || value === null) {
      if (spec.required) return null;
      continue;
    }
    // Denylist check applies to the KEY before any value work (privacy
    // posture holds even if the key also appears in the allowlist).
    if (isPrivateOrSensitiveKey(key)) {
      if (spec.required) return null;
      continue;
    }
    const normalised = normaliseValue(value, spec);
    if (normalised === null) {
      if (spec.required) return null;
      continue;
    }
    properties.push({ key, value: normalised });
  }

  const occurredAt =
    typeof input.occurredAt === "string" &&
    !Number.isNaN(Date.parse(input.occurredAt))
      ? new Date(input.occurredAt).toISOString()
      : new Date().toISOString();

  return {
    name: input.name,
    occurredAt,
    institutionId: normaliseInstitutionId(input.institutionId),
    properties,
  };
}

// --- Once-only helper ----------------------------------------------------------

/**
 * A bounded, per-key once-only gate for events that would otherwise fire on
 * every retry/autosave/re-render (prompt 36: "events fire once at the correct
 * lifecycle moment"). The authoritative DB guards (status CAS, UPSERT keys)
 * remain the real dedup; this is the in-process belt for the replay paths the
 * DB guard cannot see (a retried read of an already-terminal attempt).
 * Entries are dropped wholesale once the cap is reached — a rare duplicate is
 * acceptable, unbounded memory is not.
 */
export type OnceGate = {
  /** True (and records the key) the FIRST time this id is seen. */
  claim(key: string): boolean;
  /** How many keys are currently remembered (for tests/diagnostics). */
  size(): number;
};

export const DEFAULT_ONCE_GATE_LIMIT = 5000;

export function createOnceGate(maxSize: number = DEFAULT_ONCE_GATE_LIMIT): OnceGate {
  const claimed = new Set<string>();
  return {
    claim(key: string): boolean {
      const normalized = typeof key === "string" ? key.trim() : "";
      if (!normalized) return false;
      if (claimed.has(normalized)) return false;
      if (claimed.size >= maxSize) {
        claimed.clear();
      }
      claimed.add(normalized);
      return true;
    },
    size(): number {
      return claimed.size;
    },
  };
}
