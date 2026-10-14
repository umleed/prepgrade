import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import { getSession, type AcademicSession } from "@/lib/data/classes";
import { Button, Card } from "@/components/ui";
import { SessionForm } from "../../session-form";

export const metadata: Metadata = {
  title: "Edit academic session",
};

export const instant = false;

/**
 * Rename an existing session. The record is loaded tenant-scoped, so another
 * institution's id (or a missing one) reaches `notFound()` rather than leaking.
 */
export default async function EditSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes/sessions",
  });
  const institutionId = principal.institutionId as string;
  const { id } = await params;

  let session: AcademicSession | null = null;
  let unavailable = false;
  try {
    session = await getSession(institutionId, id);
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
                This session could not be loaded until the tenant database
                migration is applied (<span className="font-mono">supabase/migrations</span>).
              </p>
              <Link href="/institution/classes/sessions" className="mt-4 inline-block">
                <Button type="button" variant="secondary" size="sm">
                  Back to sessions
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  if (!session) notFound();

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Edit academic session</h1>
          <p className="text-sm text-ink-muted">{session.name}</p>
        </div>
        <Link href={`/institution/classes/sessions/${session.id}`}>
          <Button type="button" variant="ghost" size="sm">
            Back to session
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <SessionForm
                mode="edit"
                sessionId={session.id}
                initial={{ name: session.name }}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
