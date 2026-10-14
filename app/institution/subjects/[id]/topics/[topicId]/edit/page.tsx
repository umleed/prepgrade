import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guards";
import {
  getSubject,
  getTopicForWrite,
  type TopicRecord,
} from "@/lib/data/subjects";
import { Button, Card } from "@/components/ui";
import { TopicForm } from "../../../../topic-form";

export const metadata: Metadata = {
  title: "Rename topic",
};

export const instant = false;

/**
 * Rename an institution-owned topic. The topic is loaded through the
 * WRITABLE scope and must belong to the subject in the URL, so platform rows,
 * another tenant's rows, and mismatched subject/topic pairs all reach
 * `notFound()` without leaking which case occurred. Subject and parent links
 * are deliberately not editable — moving a topic would silently re-cut every
 * future topic-level statistic (AGENTS.md §6).
 */
export default async function EditTopicPage({
  params,
}: {
  params: Promise<{ id: string; topicId: string }>;
}) {
  await connection();
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution/subjects",
  });
  const institutionId = principal.institutionId as string;
  const { id, topicId } = await params;

  let subject = null;
  let topic: TopicRecord | null = null;
  try {
    subject = await getSubject(institutionId, id);
    if (subject) topic = await getTopicForWrite(institutionId, topicId);
  } catch {
    subject = null;
  }

  if (!subject || !topic || topic.subjectId !== subject.id) notFound();

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Rename topic
          </h1>
          <p className="text-sm text-ink-muted">
            {subject.name} · {topic.name}
          </p>
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
                mode="edit"
                subjectId={subject.id}
                topicId={topic.id}
                parents={[]}
                initial={{
                  subjectId: subject.id,
                  name: topic.name,
                  parentId: topic.parentId ?? "",
                }}
              />
            </div>
          </Card>
        </div>
      </main>
    </>
  );
}
