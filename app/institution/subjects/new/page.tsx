import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { listCategories } from "@/lib/data/subjects";
import { Button, Card } from "@/components/ui";
import { SubjectForm } from "../subject-form";

export const metadata: Metadata = {
  title: "Add subject",
};

export const instant = false;

/**
 * Creation form for a new institution-owned subject. Category options come
 * from the platform lookup; if the data source isn't reachable yet the form
 * still renders without categories (a subject may be added unfiled), matching
 * the directory's honest states.
 */
export default async function NewSubjectPage() {
  await connection();
  await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });

  let categories: { id: string; name: string }[] = [];
  try {
    categories = (await listCategories()).map((category) => ({
      id: category.id,
      name: category.name,
    }));
  } catch {
    categories = [];
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Add subject
          </h1>
          <p className="text-sm text-ink-muted">
            Add a subject your institution files questions, exams, and
            analytics under.
          </p>
        </div>
        <Link href="/institution/subjects">
          <Button type="button" variant="ghost" size="sm">
            Back to subjects
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <SubjectForm mode="create" categories={categories} />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
