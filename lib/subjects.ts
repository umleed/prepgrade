/**
 * Subject + topic catalogue contract and validation — pure, dependency-free,
 * unit-testable.
 *
 * The exact same rules run in the browser (instant feedback) and on the server
 * (authoritative). Client validation is convenience only; the server ALWAYS
 * re-validates and re-checks tenancy (AGENTS.md §5, §7). No new packages.
 *
 * WHAT THIS AREA IS FOR (prompt 14)
 * Subjects and topics CATEGORISE assessment content: questions (prompt 15/16)
 * and exams (prompt 17/18) pick a subject (+ optional topics), and analytics
 * (prompt 27) group performance by them. The catalogue has two scopes:
 * - the PLATFORM catalogue (`institutionId === null`): shared starter content,
 *   clearly identified as a seed (`isSeed`), READ-ONLY for every tenant;
 * - institution additions: rows whose `institutionId` names the owning tenant
 *   explicitly, so a school's "Maths" can coexist with the platform
 *   "Mathematics" — we never assume every school uses identical naming.
 *
 * ARCHIVE, NEVER DELETE (AGENTS.md §6)
 * Future results/analytics reference `subjects.id` / `topics.id`, so the only
 * removal offered is `archived`: retired rows disappear from pickers and
 * default listings but keep resolving historically. Identifiers are stable —
 * renaming never changes an id. `subjectArchiveBlocked` / `topicArchiveBlocked`
 * encode the "don't strand live records" policy in one place.
 *
 * A name's tenant ownership and the subject/parent/category id checks are
 * NEVER validated here — they need the database and the caller's trusted
 * institution, so they live in lib/data/subjects.ts.
 */

import {
  ORG_STATUS_HINTS,
  ORG_STATUS_LABELS,
  orgTotalPages,
  toOrgContainsPattern,
  validateOrgName,
  type OrgStatus,
} from "./classes.ts";

// Reuse the shared lifecycle vocabulary (active ⇄ archived) so every
// directory in the product behaves identically; re-exported under catalogue
// names so call sites read in this module's language.
export const CATALOGUE_STATUSES = ["active", "archived"] as const;
export type CatalogueStatus = OrgStatus;

export const CATALOGUE_STATUS_LABELS = ORG_STATUS_LABELS;
export const CATALOGUE_STATUS_HINTS = ORG_STATUS_HINTS;

/** Names reuse the org-name alphabet/length rules (1–80, single line). */
export const SUBJECT_NAME_MAX_LENGTH = 80;

// --- Origin (platform catalogue vs institution addition) ----------------------

export type CatalogueOrigin = "platform" | "institution";

export const CATALOGUE_ORIGINS = ["platform", "institution"] as const;

export const CATALOGUE_ORIGIN_LABELS: Record<CatalogueOrigin, string> = {
  platform: "Platform catalogue",
  institution: "Your institution",
};

/** Origin of a catalogue row — the tenant column is the single source. */
export function originOf(record: { institutionId: string | null }): CatalogueOrigin {
  return record.institutionId === null ? "platform" : "institution";
}

/**
 * Whether the caller's institution may WRITE this row. The platform catalogue
 * is read-only for every tenant — an institution's additions are its own and
 * never mutate shared content. An unknown tenant never matches, so this fails
 * closed.
 */
export function isCatalogueRowWritable(
  institutionId: string,
  record: { institutionId: string | null },
): boolean {
  return record.institutionId !== null && record.institutionId === institutionId;
}

// --- Subject code --------------------------------------------------------------

/** Short optional label (MTH, PHY…) shown in dense tables. 1–12 of A–Z 0–9 -. */
const SUBJECT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
const FORBIDDEN_CODE_CHARS = /[\r\n\t]/;

export const SUBJECT_CODE_MAX_LENGTH = 12;

/** Validate an optional subject code. Returns a message, or `null` when usable. */
export function validateSubjectCode(rawCode: string): string | null {
  if (typeof rawCode !== "string") return null;
  const code = rawCode.trim();
  if (!code) return null; // optional
  if (code.length > SUBJECT_CODE_MAX_LENGTH) {
    return `Keep the code under ${SUBJECT_CODE_MAX_LENGTH} characters.`;
  }
  if (FORBIDDEN_CODE_CHARS.test(code)) {
    return "Use a single-line code — no line breaks or tabs.";
  }
  if (!SUBJECT_CODE_RE.test(code)) {
    return "Use letters, numbers, spaces, or - (e.g. MTH, SS-SCI).";
  }
  return null;
}

/** Uppercase trimmed form used before persisting; "" stays "". */
export function normalizeSubjectCode(rawCode: string): string {
  return typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
}

// --- Subject input -------------------------------------------------------------

export type SubjectInput = {
  name: string;
  code: string;
  /** Selected exam-category ids; "" entries are ignored. */
  categoryIds: string[];
};

export type SubjectField = keyof SubjectInput;

export type SubjectErrors = Partial<Record<SubjectField, string>>;

export const SUBJECT_INPUT_EMPTY: SubjectInput = {
  name: "",
  code: "",
  categoryIds: [],
};

/**
 * Validate a subject payload → field → message map. When `knownCategoryIds` is
 * supplied (server-side and by the form with the fetched list), ids outside it
 * are rejected — a crafted payload can never attach an unknown category.
 * Category EXISTENCE against the platform table is re-checked in the data
 * layer; this function has no database access.
 */
export function validateSubject(
  input: SubjectInput,
  knownCategoryIds?: readonly string[],
): SubjectErrors {
  const errors: SubjectErrors = {};

  const nameError = validateOrgName(input.name);
  if (nameError) errors.name = nameError;

  const codeError = validateSubjectCode(input.code);
  if (codeError) errors.code = codeError;

  if (!Array.isArray(input.categoryIds)) {
    errors.categoryIds = "Choose zero or more exam categories.";
    return errors;
  }
  if (knownCategoryIds) {
    const unknown = input.categoryIds.some(
      (id) => id !== "" && !knownCategoryIds.includes(id),
    );
    if (unknown) {
      errors.categoryIds = "Choose one of the available exam categories.";
    }
  }

  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeSubjectInput(input: SubjectInput): SubjectInput {
  return {
    name: input.name.trim(),
    code: normalizeSubjectCode(input.code),
    categoryIds: [...new Set(input.categoryIds.filter((id) => id !== ""))],
  };
}

// --- Topic input ----------------------------------------------------------------

export type TopicInput = {
  subjectId: string;
  name: string;
  /** Parent topic id (a TOP-IC), or "" for a top-level topic. */
  parentId: string;
};

export type TopicField = keyof TopicInput;

export type TopicErrors = Partial<Record<TopicField, string>>;

export const TOPIC_INPUT_EMPTY: TopicInput = {
  subjectId: "",
  name: "",
  parentId: "",
};

/**
 * Validate a topic payload. The subject/parent ids are checked against the
 * caller's tenant (and the one-level depth rule) in the data layer — here we
 * only reject structurally invalid payloads.
 */
export function validateTopic(input: TopicInput): TopicErrors {
  const errors: TopicErrors = {};

  const nameError = validateOrgName(input.name);
  if (nameError) errors.name = nameError;

  if (typeof input.subjectId !== "string" || !input.subjectId.trim()) {
    errors.subjectId = "Choose one of your subjects.";
  }
  if (typeof input.parentId !== "string") {
    errors.parentId = "Choose a parent topic, or none.";
  } else if (input.parentId && input.parentId === input.subjectId) {
    // A topic can never be its own parent; the DB CHECK enforces this too.
    errors.parentId = "A topic cannot be its own parent.";
  }

  return errors;
}

/** Trimmed, normalised form used before persisting. */
export function normalizeTopicInput(input: TopicInput): TopicInput {
  return {
    subjectId: input.subjectId.trim(),
    name: input.name.trim(),
    parentId: input.parentId.trim(),
  };
}

// --- Archive policy --------------------------------------------------------------

/** Facts about a subject needed to decide whether it can be archived. */
export type SubjectArchiveFacts = {
  /** Active (non-archived) topics visible to this tenant under the subject. */
  activeTopics: number;
};

/**
 * Why archiving a subject is refused, or `null` when it may be archived.
 * Active topics under it are the block: retiring the subject would strand
 * them in the picker, so the tenant archives/moves its own topics first.
 */
export function subjectArchiveBlocked(
  facts: SubjectArchiveFacts,
): { blocked: true; reason: "topicsAttached"; message: string } | null {
  if (facts.activeTopics > 0) {
    return {
      blocked: true,
      reason: "topicsAttached",
      message: `Archive the ${facts.activeTopics} active topic${
        facts.activeTopics === 1 ? "" : "s"
      } under this subject first. Past results keep working either way.`,
    };
  }
  return null;
}

/** Facts about a topic needed to decide whether it can be archived. */
export type TopicArchiveFacts = {
  /** Active subtopics still attached to this topic. */
  activeChildTopics: number;
};

/** Why archiving a topic is refused, or `null` when it may be archived. */
export function topicArchiveBlocked(facts: TopicArchiveFacts):
  | { blocked: true; reason: "subtopicsAttached"; message: string }
  | null {
  if (facts.activeChildTopics > 0) {
    return {
      blocked: true,
      reason: "subtopicsAttached",
      message: `Archive the ${facts.activeChildTopics} subtopic${
        facts.activeChildTopics === 1 ? "" : "s"
      } under this topic first.`,
    };
  }
  return null;
}

/**
 * Whether a subject/topic may be *newly* selected (in a question or exam
 * workflow). Archived rows stay readable for history but are never offered in
 * pickers; an unknown status fails closed.
 */
export function isCatalogueItemSelectable(status: string): boolean {
  return status === "active";
}

// --- List query resolution (search / filter / pagination) ------------------------

export const SUBJECT_PAGE_SIZE = 20;

/**
 * Filters + pagination for the subject directory. `status`/`origin` `null`
 * mean "all". Values arrive from searchParams, which is untrusted input, so
 * everything is clamped here.
 */
export type SubjectListQuery = {
  q: string;
  categoryId: string;
  status: CatalogueStatus | null;
  origin: CatalogueOrigin | null;
  page: number;
  pageSize: number;
};

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function safePage(raw: string | string[] | undefined): number {
  const parsed = Number.parseInt(firstValue(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function safeStatus(raw: string | string[] | undefined): CatalogueStatus | null {
  const value = firstValue(raw);
  return CATALOGUE_STATUSES.includes(value as CatalogueStatus)
    ? (value as CatalogueStatus)
    : null;
}

function safeOrigin(raw: string | string[] | undefined): CatalogueOrigin | null {
  const value = firstValue(raw);
  return CATALOGUE_ORIGINS.includes(value as CatalogueOrigin)
    ? (value as CatalogueOrigin)
    : null;
}

/**
 * Turn raw searchParams into a safe, bounded subject-directory query. Unknown
 * status/origin values collapse to "all", pages clamp to >= 1, and the search
 * term is trimmed and length-bounded so a hostile URL cannot produce a
 * runaway query. Same contract as resolveClassListQuery.
 */
export function resolveSubjectListQuery(searchParams: {
  q?: string | string[];
  category?: string | string[];
  status?: string | string[];
  origin?: string | string[];
  page?: string | string[];
}): SubjectListQuery {
  return {
    q: firstValue(searchParams.q).trim().slice(0, 120),
    categoryId: firstValue(searchParams.category).trim(),
    status: safeStatus(searchParams.status),
    origin: safeOrigin(searchParams.origin),
    page: safePage(searchParams.page),
    pageSize: SUBJECT_PAGE_SIZE,
  };
}

/** Build a subject-directory URL for a page, preserving current filters. */
export function subjectPageHref(
  base: string,
  query: SubjectListQuery,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.categoryId) params.set("category", query.categoryId);
  if (query.status) params.set("status", query.status);
  if (query.origin) params.set("origin", query.origin);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export { orgTotalPages, toOrgContainsPattern };
