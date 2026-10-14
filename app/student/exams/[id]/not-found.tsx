import Link from "next/link";
import { Button, EmptyState } from "@/components/ui";

/**
 * Not-found boundary for the pre-exam instructions route (prompt 21). A
 * student reaching an id that is not their own assigned, released exam
 * lands here via `notFound()`. The copy never distinguishes "does not
 * exist" from "not yours" — existence in another institution or of an
 * unreleased exam is never confirmed (AGENTS.md §5).
 */
export default function StudentExamNotFound() {
  return (
    <>
      <header className="flex shrink-0 items-center border-b border-border bg-surface px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight text-ink">
          Exam not available
        </h1>
      </header>
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <EmptyState
          title="This exam isn't available to you"
          description="It may not be assigned to you, may no longer be released to students, or may belong to another institution. We never confirm which — go back to My Exams to see the exams that are yours."
          action={
            <Link href="/student/exams">
              <Button type="button" variant="secondary" size="sm">
                Back to My Exams
              </Button>
            </Link>
          }
        />
      </main>
    </>
  );
}
