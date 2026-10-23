/**
 * Examination-preparation data access — SERVER-ONLY.
 *
 * Powers the JAMB / WAEC / NECO destinations in the Institution workspace.
 * These are NOT placeholder pages: the platform `exam_categories` lookup
 * (migration 0005) seeds JAMB/WAEC/NECO/CUSTOM codes, and BOTH `exams` and
 * `questions` carry an `exam_category_id`, so an institution's real exams and
 * questions already filed under a category are shown here — with an honest
 * empty state when nothing is filed yet, never fabricated content.
 *
 * TRUST CONTRACT (AGENTS.md §5): `institutionId` comes from the server-resolved
 * `AuthPrincipal`, never the request; every read is hard-filtered by
 * `.eq("institution_id", trusted)`. The `code` (JAMB/WAEC/NECO) selects which
 * PLATFORM category to show and is looked up against `exam_categories` — it is
 * never used to widen the tenant scope.
 *
 * HONEST FAILURES (AGENTS.md §7): missing env, an unreadable schema, or a
 * category that is not present each map to a typed status the page renders as
 * an explanation — not as empty-looking fake data.
 */

import "server-only";
import { createAdminClient, DataSourceUnavailableError } from "@/lib/supabase/server";
import { listCategories, type ExamCategory } from "@/lib/data/subjects";

/** A category-scoped exam row for the prep list (minimal fields only). */
export type ExamPrepExam = {
  id: string;
  title: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  subjectName: string;
};

export type ExamPrepResult =
  | {
      status: "resolved";
      category: ExamCategory;
      exams: ExamPrepExam[];
      questionCount: number;
    }
  /** The requested code has no matching (active) platform category yet. */
  | { status: "no-category" }
  /** Supabase variables are absent on the server. */
  | { status: "unconfigured" }
  /** A read failed (schema not applied, network, etc.). */
  | { status: "unavailable" };

/**
 * Load one institution's exams and active-question count for a single exam
 * category (by platform code such as "JAMB"). Performs no auth itself — the
 * calling page enforces INSTITUTION_ADMIN and passes only the trusted tenant id.
 */
export async function getExamPrep(
  institutionId: string,
  code: string,
): Promise<ExamPrepResult> {
  const trusted = institutionId?.trim() ?? "";
  const wanted = code.trim().toUpperCase();
  if (!trusted || !wanted) return { status: "no-category" };

  // 1. Resolve the requested code to a real platform category id. `listCategories`
  //    already scopes to active rows; a code it does not contain is reported, not
  //    guessed. A missing data source is surfaced as `unconfigured`.
  let categories: ExamCategory[];
  try {
    categories = await listCategories();
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) return { status: "unconfigured" };
    console.error("[exam-prep] category lookup failed", wanted);
    return { status: "unavailable" };
  }

  const category = categories.find((c) => c.code.toUpperCase() === wanted);
  if (!category) return { status: "no-category" };

  let supabase;
  try {
    supabase = createAdminClient();
  } catch (error) {
    if (error instanceof DataSourceUnavailableError) return { status: "unconfigured" };
    console.error("[exam-prep] data source could not be created");
    return { status: "unavailable" };
  }

  // 2. The institution's exams in this category (all statuses; newest first).
  const { data: examRows, error: examsError } = await supabase
    .from("exams")
    .select("id, title, status, starts_at, ends_at, subject_id")
    .eq("institution_id", trusted)
    .eq("exam_category_id", category.id)
    .order("created_at", { ascending: false });
  if (examsError) {
    console.error("[exam-prep] exam lookup failed", trusted, examsError.code);
    return { status: "unavailable" };
  }

  // 3. Active questions in this category — a count only, no personal rows.
  const { count: questionCount, error: questionError } = await supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .eq("institution_id", trusted)
    .eq("exam_category_id", category.id)
    .eq("status", "active");
  if (questionError) {
    console.error("[exam-prep] question count failed", trusted, questionError.code);
    return { status: "unavailable" };
  }

  // 4. Resolve subject names for the exams (presentation only). A failure here
  //    degrades to a neutral label rather than dropping the exam rows — the list
  //    is real regardless of whether the name lookup succeeded.
  const subjectIds = Array.from(
    new Set(
      (examRows ?? [])
        .map((row) => (row as { subject_id: string | null }).subject_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const subjectNames = new Map<string, string>();
  if (subjectIds.length > 0) {
    const { data: subjectRows } = await supabase
      .from("subjects")
      .select("id, name")
      .in("id", subjectIds);
    for (const row of subjectRows ?? []) {
      const r = row as unknown as { id: string; name: string | null };
      subjectNames.set(r.id, r.name ?? "");
    }
  }

  const exams: ExamPrepExam[] = (examRows ?? []).map((row) => {
    const r = row as unknown as {
      id: string;
      title: string;
      status: string;
      starts_at: string | null;
      ends_at: string | null;
      subject_id: string | null;
    };
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      subjectName: (r.subject_id && subjectNames.get(r.subject_id)) || "—",
    };
  });

  return {
    status: "resolved",
    category,
    exams,
    questionCount: questionCount ?? 0,
  };
}
