"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/guards";
import {
  validateSubject,
  validateTopic,
  type CatalogueStatus,
  type SubjectErrors,
  type SubjectInput,
  type TopicErrors,
  type TopicInput,
} from "@/lib/subjects";
import {
  createSubject,
  createTopic,
  listCategories,
  setSubjectStatus,
  setTopicStatus,
  updateSubject,
  updateTopic,
} from "@/lib/data/subjects";

/**
 * Result a subject mutation returns to the client form. `errors` are per-field
 * messages; `message` is a form-level note (record vanished, the archive guard
 * refused, or a platform row that is read-only for tenants). Nothing here
 * trusts the browser: every action re-resolves the tenant from the session and
 * re-validates before touching data, and the tenant id is never read from the
 * payload (AGENTS.md §5).
 */
export type SubjectActionResult =
  | { ok: true; id?: string }
  | { ok: false; errors: SubjectErrors; message?: string };

/** Result a topic mutation returns to the client form. */
export type TopicActionResult =
  | { ok: true; id?: string }
  | { ok: false; errors: TopicErrors; message?: string };

function revalidateSubjectPaths(id?: string) {
  revalidatePath("/institution/subjects");
  if (id) revalidatePath(`/institution/subjects/${id}`);
}

/**
 * Re-run subject validation against the ACTIVE platform category list — the
 * server's authoritative option set — and return field errors, or `null`.
 */
async function subjectErrorsFor(input: SubjectInput): Promise<SubjectErrors | null> {
  const categories = await listCategories();
  const errors = validateSubject(input, categories.map((category) => category.id));
  return Object.keys(errors).length > 0 ? errors : null;
}

function topicErrorsFor(input: TopicInput): TopicErrors | null {
  const errors = validateTopic(input);
  return Object.keys(errors).length > 0 ? errors : null;
}

// --- Subjects -----------------------------------------------------------------

/**
 * Create an institution-owned subject for the signed-in admin's own
 * institution. The tenant id comes from the trusted principal, never the
 * payload, so a crafted request cannot add platform-catalogue content.
 */
export async function createSubjectAction(
  input: SubjectInput,
): Promise<SubjectActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;

  const errors = await subjectErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await createSubject(institutionId, input);
  if (!result.ok) return { ok: false, errors: result.errors };

  revalidateSubjectPaths(result.id);
  return { ok: true, id: result.id };
}

/** Update an institution-owned subject, scoped to the caller's tenant. */
export async function updateSubjectAction(
  id: string,
  input: SubjectInput,
): Promise<SubjectActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;

  const errors = await subjectErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await updateSubject(institutionId, id, input);
  if (!result.ok) {
    // Empty field errors means the id did not resolve as a WRITABLE row under
    // this tenant (absent, foreign, or platform-owned) — report it without
    // confirming which of the three it is.
    if (Object.keys(result.errors).length === 0) {
      return {
        ok: false,
        errors: {},
        message: "This subject could not be found or is read-only platform content.",
      };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateSubjectPaths(id);
  return { ok: true, id };
}

/**
 * Archive or restore an institution-owned subject — the non-destructive
 * removal (AGENTS.md §6). The data layer refuses to archive while active
 * topics are attached and never writes platform rows; both refusals surface as
 * messages rather than silent no-ops.
 */
export async function setSubjectStatusAction(
  id: string,
  status: CatalogueStatus,
): Promise<SubjectActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;

  const result = await setSubjectStatus(institutionId, id, status);
  if (!result.ok) {
    if (result.reason === "topicsAttached") {
      return {
        ok: false,
        errors: {},
        message: `Archive the ${result.attached} active topic${
          result.attached === 1 ? "" : "s"
        } under this subject first. Past results keep working either way.`,
      };
    }
    return {
      ok: false,
      errors: {},
      message: "This subject could not be found or is read-only platform content.",
    };
  }

  revalidateSubjectPaths(id);
  return { ok: true, id };
}

// --- Topics ---------------------------------------------------------------------

/**
 * Add an institution-owned topic under a subject the caller can see (platform
 * or own). Subject/parent validity is enforced tenant-side in the data layer.
 */
export async function createTopicAction(
  input: TopicInput,
): Promise<TopicActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;

  const errors = topicErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await createTopic(institutionId, input);
  if (!result.ok) return { ok: false, errors: result.errors };

  revalidateSubjectPaths(input.subjectId);
  return { ok: true, id: result.id };
}

/** Rename an institution-owned topic (links to subject/parent never move). */
export async function updateTopicAction(
  id: string,
  input: TopicInput,
): Promise<TopicActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;

  const errors = topicErrorsFor(input);
  if (errors) return { ok: false, errors };

  const result = await updateTopic(institutionId, id, input);
  if (!result.ok) {
    if (Object.keys(result.errors).length === 0) {
      return {
        ok: false,
        errors: {},
        message: "This topic could not be found or is read-only platform content.",
      };
    }
    return { ok: false, errors: result.errors };
  }

  revalidateSubjectPaths(input.subjectId);
  return { ok: true, id };
}

/** Archive or restore an institution-owned topic, refusing while subtopics live. */
export async function setTopicStatusAction(
  subjectId: string,
  id: string,
  status: CatalogueStatus,
): Promise<TopicActionResult> {
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;

  const result = await setTopicStatus(institutionId, id, status);
  if (!result.ok) {
    if (result.reason === "subtopicsAttached") {
      return {
        ok: false,
        errors: {},
        message: `Archive the ${result.attached} active subtopic${
          result.attached === 1 ? "" : "s"
        } under this topic first.`,
      };
    }
    return {
      ok: false,
      errors: {},
      message: "This topic could not be found or is read-only platform content.",
    };
  }

  revalidateSubjectPaths(subjectId);
  return { ok: true, id };
}
