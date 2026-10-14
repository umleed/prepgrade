import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { listSessionOptions } from "@/lib/data/classes";
import { Button, Card } from "@/components/ui";
import { ClassForm } from "../class-form";

export const metadata: Metadata = {
  title: "Add class",
};

export const instant = false;

/**
 * Creation form for a new class. Session options are read from the caller's
 * tenant; if the data source isn't reachable yet the form still renders with no
 * sessions (a class may be created unassigned), matching the directory's honest
 * states.
 */
export default async function NewClassPage() {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes",
  });

  let sessions: { id: string; name: string }[] = [];
  try {
    sessions = await listSessionOptions(principal.institutionId as string);
  } catch {
    sessions = [];
  }

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Add class</h1>
          <p className="text-sm text-ink-muted">
            Create a class to organise students and assign assessments.
          </p>
        </div>
        <Link href="/institution/classes">
          <Button type="button" variant="ghost" size="sm">
            Back to classes
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <ClassForm mode="create" sessions={sessions} />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
