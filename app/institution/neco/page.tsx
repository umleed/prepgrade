import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { examPrepPath, type ExamPrepCode } from "@/lib/navigation/institution-nav";
import { Button } from "@/components/ui";
import { ExamPrepContent } from "@/app/institution/exam-prep-content";

export const metadata: Metadata = { title: "NECO" };

// Reads the live session and queries the tenant database — never prerendered.
export const instant = false;

const CODE: ExamPrepCode = "NECO";
const BASE = examPrepPath(CODE);

/**
 * NECO preparation — a real, institution-owned destination (the reported bug
 * that JAMB/WAEC/NECO had no destination). Rendered inside the Institution
 * shell, admitted ONLY to INSTITUTION_ADMIN, and scoped to the trusted tenant.
 * Shows this institution's NECO exams and question count, with honest empty
 * states.
 */
export default async function InstitutionNecoPage() {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], { next: BASE });
  const institutionId = principal.institutionId as string;

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">NECO</h1>
          <p className="text-sm text-ink-muted">
            Your institution&apos;s NECO-category exams and questions.
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
            label="NECO"
            basePath={BASE}
          />
        </div>
      </main>
    </>
  );
}
