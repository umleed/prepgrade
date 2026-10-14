import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import {
  getSubject,
  listTopicsForSubject,
  type SubjectRecord,
  type TopicRecord,
} from "@/lib/data/subjects";
import { Button, Card } from "@/components/ui";
import { TopicForm } from "../../../topic-form";

export const metadata: Metadata = {
  title: "Add topic",
};

export const instant = false;

/**
 * Add a topic to a subject the caller can see (platform subjects included —
 * the new topic row is still owned by the caller's institution). The subject
 * must be active and institution-writable context aside, the page offers the
 * active top-level topics as parent choices for the one allowed subtopic level.
 */
export default async function NewTopicPage({
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

  let subject: SubjectRecord | null = null;
  let topics: TopicRecord[] = [];
  try {
    subject = await getSubject(institutionId, id);
    if (subject) topics = await listTopicsForSubject(institutionId, subject.id);
  } catch {
    subject = null;
  }

  if (!subject) notFound();

  // Topics can only be newly added to an ACTIVE subject; an archived one is
  // retired for history only (AGENTS.md §6).
  if (subject.status !== "active") {
    return (
      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-5">
              <p className="text-sm text-ink-muted">
                “{subject.name}” is archived, so new topics cannot be added to
                it. Restore the subject first.
              </p>
              <Link
                href={`/institution/subjects/${subject.id}`}
                className="mt-4 inline-block"
              >
                <Button type="button" variant="secondary" size="sm">
                  Back to subject
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  const parents = topics
    .filter((topic) => !topic.parentId && topic.status === "active")
    .map((topic) => ({ id: topic.id, name: topic.name }));

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Add topic
          </h1>
          <p className="text-sm text-ink-muted">Subject: {subject.name}</p>
        </div>
        <Link href={`/institution/subjects/${subject.id}`}>
          <Button type="button" variant="ghost" size="sm">
            Back to subject
          </Button>
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <div className="p-6">
              <TopicForm
                mode="create"
                subjectId={subject.id}
                parents={parents}
                initial={{ subjectId: subject.id, name: "", parentId: "" }}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
