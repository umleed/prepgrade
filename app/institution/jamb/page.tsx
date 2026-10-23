import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { examPrepPath, type ExamPrepCode } from "@/lib/navigation/institution-nav";
import { Button } from "@/components/ui";
import { ExamPrepContent } from "@/app/institution/exam-prep-content";

export const metadata: Metadata = { title: "JAMB" };

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

const CODE: ExamPrepCode = "JAMB";
const BASE = examPrepPath(CODE);

/**
 * JAMB preparation — a real, institution-owned destination (the reported bug
 * that JAMB/WAEC/NECO had no destination). Rendered inside the Institution
 * shell, admitted ONLY to INSTITUTION_ADMIN, and scoped to the trusted tenant.
 * It shows this institution's JAMB exams and question count (from the platform
 * `exam_categories` code + `exam_category_id`), with honest empty states.
 */
export default async function InstitutionJambPage() {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], { next: BASE });
  const institutionId = principal.institutionId as string;

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">JAMB</h1>
          <p className="text-sm text-ink-muted">
            Your institution&apos;s JAMB-category exams and questions.
          </p>
        </div>
        <Link href="/institution">
          <Button type="button" variant="ghost" size="sm">
            Back to dashboard
          </Button>
        </Link>
      </header>
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-5xl">
          <ExamPrepContent
            institutionId={institutionId}
            code={CODE}
            label="JAMB"
            basePath={BASE}
          />
        </div>
      </main>
    </>
  );
}
