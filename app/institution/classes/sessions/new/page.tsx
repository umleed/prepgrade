import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { Button, Card } from "@/components/ui";
import { SessionForm } from "../session-form";

export const metadata: Metadata = {
  title: "Add academic session",
};

export const instant = false;

/** Creation form for a new academic session. */
export default async function NewSessionPage() {
  await connection();
  await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/classes/sessions",
  });

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Add academic session</h1>
          <p className="text-sm text-ink-muted">
            Create an academic year that classes can belong to.
          </p>
        </div>
        <Link href="/institution/classes/sessions">
          <Button type="button" variant="ghost" size="sm">
            Back to sessions
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <SessionForm mode="create" />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
