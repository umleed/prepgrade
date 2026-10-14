import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import { getClass, listSessionOptions, type ClassRecord } from "@/lib/data/classes";
import { Button, Card } from "@/components/ui";
import { ClassForm } from "../../class-form";

export const metadata: Metadata = {
  title: "Edit class",
};

export const instant = false;

/**
 * Edit an existing class. The record is loaded tenant-scoped, so another
 * institution's id (or a missing one) reaches `notFound()` rather than leaking.
 * The session dropdown lists active sessions plus the class's own current
 * session, so a link to a since-archived year still displays correctly.
 */
export default async function EditClassPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes",
  });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let record: ClassRecord | null = null;
  let sessions: { id: string; name: string }[] = [];
  let unavailable = false;
  try {
    [record, sessions] = await Promise.all([
      getClass(institutionId, id),
      listSessionOptions(institutionId),
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
                This class could not be loaded until the tenant database
                migration is applied (<span className="font-mono">supabase/migrations</span>).
              </p>
              <Link href="/institution/classes" className="mt-4 inline-block">
                <Button type="button" variant="secondary" size="sm">
                  Back to classes
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  if (!record) notFound();

  // Keep the class's current session selectable even when it is archived and so
  // excluded from the active-options list.
  if (record.academicSessionId && !sessions.some((s) => s.id === record.academicSessionId)) {
    sessions = [
      { id: record.academicSessionId, name: record.academicSessionName ?? "Current session" },
      ...sessions,
    ];
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Edit class</h1>
          <p className="text-sm text-ink-muted">{record.name}</p>
        </div>
        <Link href={`/institution/classes/${record.id}`}>
          <Button type="button" variant="ghost" size="sm">
            Back to profile
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <ClassForm
                mode="edit"
                classId={record.id}
                sessions={sessions}
                initial={{
                  name: record.name,
                  academicSessionId: record.academicSessionId ?? "",
                }}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
