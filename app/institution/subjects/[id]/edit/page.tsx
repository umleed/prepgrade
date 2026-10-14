import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import {
  getSubjectForWrite,
  listCategories,
  type SubjectRecord,
} from "@/lib/data/subjects";
import { Button, Card } from "@/components/ui";
import { SubjectForm } from "../../subject-form";

export const metadata: Metadata = {
  title: "Edit subject",
};

export const instant = false;

/**
 * Edit an existing institution-owned subject. The record is loaded through the
 * WRITABLE scope, so a platform-catalogue id (read-only for every tenant) or
 * another institution's id reaches `notFound()` rather than leaking which of
 * the three it was.
 */
export default async function EditSubjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let record: SubjectRecord | null = null;
  let categories: { id: string; name: string }[] = [];
  let unavailable = false;
  try {
    [record, categories] = await Promise.all([
      getSubjectForWrite(institutionId, id),
      listCategories().then((list) =>
        list.map((category) => ({ id: category.id, name: category.name })),
      ),
    ]);
  } catch {
    unavailable = true;
  }

  if (unavailable) {
    return (
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-5">
              <p className="text-sm text-ink-muted">
                This subject could not be loaded until the catalogue migration
                is applied (<span className="font-mono">supabase/migrations</span>).
              </p>
              <Link href="/institution/subjects" className="mt-4 inline-block">
                <Button type="button" variant="secondary" size="sm">
                  Back to subjects
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  if (!record) notFound();

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Edit subject
          </h1>
          <p className="text-sm text-ink-muted">{record.name}</p>
        </div>
        <Link href={`/institution/subjects/${record.id}`}>
          <Button type="button" variant="ghost" size="sm">
            Back to subject
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <SubjectForm
                mode="edit"
                subjectId={record.id}
                categories={categories}
                initial={{
                  name: record.name,
                  code: record.code ?? "",
                  categoryIds: record.categoryIds,
                }}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
