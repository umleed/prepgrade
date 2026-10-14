import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import {
  getExam,
  getExamAudience,
  listAssignableClasses,
  listAssignableStudents,
  type ExamRecord,
} from "@/lib/data/exams";
import { examBuilderEditable } from "@/lib/exams";
import { DataSourceUnavailableError } from "@/lib/supabase/server";
import { Alert, Breadcrumbs, Button, EmptyState } from "@/components/ui";
import { AssignExamPanel } from "./assign-exam-panel";

export const metadata: Metadata = {
  title: "Assign exam",
};

export const instant = false;

function PageHeader({ examId, examTitle }: { examId: string; examTitle: string }) {
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-6 py-4">
      <Breadcrumbs
        items={[
          { label: "Exams", href: "/teacher/exams" },
          { label: examTitle, href: `/teacher/exams/${examId}` },
          { label: "Assign" },
        ]}
      />
      <h1 className="text-xl font-bold tracking-tight text-ink">
        Assign &amp; publish
      </h1>
      <p className="max-w-2xl text-sm text-ink-muted">
        Choose the classes and individual students who will take this exam,
        review exactly who receives it and when, then publish. Nothing reaches
        students until the exam is published.
      </p>
    </header>
  );
}

/**
 * Assignment & publishing screen (prompt 19). Server Component: resolves
 * the trusted tenant, loads the exam, the picker data (active classes with
 * live roster counts, active students), and the CURRENT saved audience —
 * then hands immutable plain data to the client panel. Every id offered
 * here was already tenant-filtered server-side; the panel's saves are
 * re-validated anyway (AGENTS.md §5).
 */
export default async function AssignExamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();

  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/exams",
  });
  const institutionId = principal.institutionId as string;

  const { id } = await params;

  let exam: ExamRecord | null = null;
  let audienceClasses: Awaited<ReturnType<typeof listAssignableClasses>> = [];
  let audienceStudents: Awaited<ReturnType<typeof listAssignableStudents>> = [];
  let savedAudience: Awaited<ReturnType<typeof getExamAudience>> = null;
  let loadError: "unconfigured" | "unavailable" | null = null;
  try {
    exam = await getExam(institutionId, id);
    if (exam) {
      [audienceClasses, audienceStudents, savedAudience] = await Promise.all([
        listAssignableClasses(institutionId),
        listAssignableStudents(institutionId, { limit: 200 }),
        getExamAudience(institutionId, id),
      ]);
    }
  } catch (error) {
    loadError =
      error instanceof DataSourceUnavailableError ? "unconfigured" : "unavailable";
  }

  if (loadError) {
    return (
      <>
        <PageHeader examId={id} examTitle="Exam" />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            {loadError === "unconfigured" ? (
              <Alert variant="warning" title="Exam data is not configured">
                Supabase connection variables are missing on the server.
              </Alert>
            ) : (
              <Alert variant="danger" title="Exam data is unavailable">
                This exam could not be loaded. This is expected until the exam
                assignment migration is applied to your Supabase project
                (<span className="font-mono">supabase/migrations</span>).
              </Alert>
            )}
          </div>
        </main>
      </>
    );
  }

  if (!exam) {
    return (
      <>
        <PageHeader examId={id} examTitle="Exam" />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <EmptyState
            title="Exam not found"
            description="This exam is not in your institution, or it has been removed. We never confirm whether an exam exists in another institution."
            action={
              <Link href="/teacher/exams">
                <Button type="button" variant="secondary" size="sm">
                  Back to exams
                </Button>
              </Link>
            }
          />
        </main>
      </>
    );
  }

  // Published (or retired) exams have a frozen audience — publishing is a
  // one-way door, so the flow offers no editor, only the honest state and
  // a route back to what IS still possible (view questions, close later).
  if (!examBuilderEditable(exam.status)) {
    return (
      <>
        <PageHeader examId={exam.id} examTitle={exam.title} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <Alert variant="info" title="Assignments are frozen once an exam publishes">
              {"publishedTo" in exam && exam.publishedTo !== null
                ? `This exam was published to ${exam.publishedTo} student${
                    exam.publishedTo === 1 ? "" : "s"
                  }. Its audience can no longer change so delivered and historical attempts stay intact.`
                : "This exam has been published, so its audience can no longer change here."}
            </Alert>
            <div className="mt-4">
              <Link href={`/teacher/exams/${exam.id}`}>
                <Button type="button" variant="secondary" size="sm">
                  Back to exam details
                </Button>
              </Link>
            </div>
          </div>
        </main>
      </>
    );
  }

  const savedClassIds = savedAudience?.classes.map((entry) => entry.id) ?? exam.assignedClasses.map((entry) => entry.id);
  // Students already saved but outside the bounded picker page must still
  // render in the review tab — merge them into the options.
  const pickerIds = new Set(audienceStudents.map((student) => student.id));
  const savedExtras = (savedAudience?.students ?? [])
    .filter((student) => !pickerIds.has(student.id))
    .map((student) => ({
      id: student.id,
      fullName: student.fullName,
      studentCode: "—",
      classId: null as string | null,
    }));

  return (
    <>
      <PageHeader examId={exam.id} examTitle={exam.title} />
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <AssignExamPanel
          exam={{
            id: exam.id,
            title: exam.title,
            subjectName: exam.subjectName,
            durationMinutes: exam.durationMinutes,
            maxAttempts: exam.maxAttempts,
            questionCount: exam.questionCount,
            totalMarks: exam.totalMarks,
            startsAt: exam.startsAt,
            endsAt: exam.endsAt,
            status: exam.status,
          }}
          classes={audienceClasses}
          students={[...audienceStudents, ...savedExtras]}
          initialClassIds={savedClassIds}
          initialStudentIds={savedAudience?.students.map((student) => student.id) ?? []}
        />
      </main>
    </>
  );
}
