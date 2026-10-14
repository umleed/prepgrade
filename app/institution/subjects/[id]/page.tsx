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
import {
  CATALOGUE_STATUS_HINTS,
  CATALOGUE_STATUS_LABELS,
  isCatalogueRowWritable,
  originOf,
} from "@/lib/subjects";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { SubjectStatusButton } from "../subject-status-button";
import { TopicStatusButton } from "../topic-status-button";

export const metadata: Metadata = {
  title: "Subject",
};

export const instant = false;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

function TopicOriginBadge({ topic }: { topic: TopicRecord }) {
  return originOf(topic) === "platform" ? (
    <Badge tone="brand">
      Platform{topic.isSeed ? " · starter" : ""}
    </Badge>
  ) : null;
}

function TopicStatusBadge({ status }: { status: TopicRecord["status"] }) {
  return (
    <Badge tone={status === "active" ? "success" : "neutral"} dot>
      {CATALOGUE_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * Topic branch: top-level topics with their subtopics indented beneath.
 * Rename/archive controls only appear for the tenant's OWN writable rows —
 * platform topics are read-only here, and the server actions enforce the same
 * rule, so hiding the button is presentation, not protection.
 */
function TopicBranch({
  topics,
  subjectId,
  institutionId,
}: {
  topics: TopicRecord[];
  subjectId: string;
  institutionId: string;
}) {
  const roots = topics.filter((topic) => !topic.parentId);
  const childrenOf = new Map<string, TopicRecord[]>();
  for (const topic of topics) {
    if (!topic.parentId) continue;
    const list = childrenOf.get(topic.parentId) ?? [];
    list.push(topic);
    childrenOf.set(topic.parentId, list);
  }

  function renderRow(topic: TopicRecord, isChild: boolean) {
    // Only the tenant's OWN topics are writable; platform rows are read-only
    // here, and the server actions enforce the same rule.
    const canWrite = isCatalogueRowWritable(institutionId, topic);
    return (
      <div
        key={topic.id}
        className={
          isChild
            ? "flex items-center justify-between gap-3 border-b border-border py-2.5 pl-8 last:border-b-0"
            : "flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0"
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isChild ? (
            <span aria-hidden="true" className="text-ink-subtle">
              └
            </span>
          ) : null}
          <span className="truncate text-sm font-medium text-ink">
            {topic.name}
          </span>
          <TopicOriginBadge topic={topic} />
          <TopicStatusBadge status={topic.status} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canWrite ? (
            <>
              <Link href={`/institution/subjects/${subjectId}/topics/${topic.id}/edit`}>
                <Button type="button" variant="secondary" size="sm">
                  Rename
                </Button>
              </Link>
              <TopicStatusButton
                subjectId={subjectId}
                topicId={topic.id}
                status={topic.status}
                attachedSubtopics={topic.childCount}
              />
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      {roots.map((root) => (
        <div key={root.id}>
          {renderRow(root, false)}
          {(childrenOf.get(root.id) ?? []).map((child) =>
            renderRow(child, true),
          )}
        </div>
      ))}
    </div>
  );
}

export default async function SubjectProfilePage({
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
  let topics: TopicRecord[] = [];
  let unavailable = false;
  try {
    record = await getSubject(institutionId, id);
    if (record) topics = await listTopicsForSubject(institutionId, record.id);
  } catch {
    // Any read failure (data source unconfigured, or the catalogue tables not
    // yet applied) is a "cannot load" state — distinct from a real 404, so it
    // is surfaced honestly instead of misleadingly reporting "not found".
    unavailable = true;
  }

  if (unavailable) {
    return (
      <>
        <ProfileHeader name="Subject" />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <Alert variant="danger" title="Subject data is unavailable">
              This subject could not be loaded. It is expected until the
              catalogue migration is applied
              (<span className="font-mono">supabase/migrations</span>).
            </Alert>
          </div>
        </main>
      </>
    );
  }

  // getSubject is tenant-scoped (platform ∪ own), so `null` means "no such
  // subject for you" — an id from another tenant also lands here, never
  // leaking that the record exists elsewhere.
  if (!record) notFound();

  const writable = isCatalogueRowWritable(institutionId, record);
  const isPlatform = originOf(record) === "platform";

  return (
    <>
      <ProfileHeader name={record.name} />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <Card>
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-ink">
                  {record.name}
                  {record.code ? (
                    <span className="ml-2 text-sm font-medium text-ink-muted">
                      {record.code}
                    </span>
                  ) : null}
                </h2>
                <p className="text-sm text-ink-muted">
                  {record.categoryNames.length > 0
                    ? record.categoryNames.join(" · ")
                    : "No exam categories"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={record.status === "active" ? "success" : "neutral"} dot>
                  {CATALOGUE_STATUS_LABELS[record.status]}
                </Badge>
                {writable ? (
                  <Link href={`/institution/subjects/${record.id}/edit`}>
                    <Button type="button" variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                ) : null}
              </div>
            </div>
          </Card>

          <Card>
            <dl className="px-5 py-2">
              <Detail label="Source">
                {isPlatform ? (
                  <span>
                    Platform catalogue
                    {record.isSeed
                      ? " — clearly identified starter content. Your institution can add its own subjects with its own naming."
                      : " — read-only shared content."}
                  </span>
                ) : (
                  "Your institution"
                )}
              </Detail>
              <Detail label="Exam categories">
                {record.categoryNames.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {record.categoryNames.map((name) => (
                      <Badge key={name} tone="info">
                        {name}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-ink-subtle">None</span>
                )}
              </Detail>
              <Detail label="Topics">{record.topicCount}</Detail>
              <Detail label="Created">
                {new Date(record.createdAt).toLocaleDateString()}
              </Detail>
            </dl>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-4 p-5">
              <div>
                <h3 className="text-sm font-semibold text-ink">Topics</h3>
                <p className="text-xs text-ink-muted">
                  What questions and topic analytics group by within this
                  subject.
                </p>
              </div>
              {writable && record.status === "active" ? (
                <Link href={`/institution/subjects/${record.id}/topics/new`}>
                  <Button type="button" variant="primary" size="sm">
                    Add topic
                  </Button>
                </Link>
              ) : null}
            </div>
            <div className="border-t border-border px-5 py-2">
              {topics.length === 0 ? (
                <EmptyState
                  title="No topics yet"
                  description={
                    writable
                      ? "Add the first topic so questions in this subject can be grouped for revision and analytics."
                      : "The platform starter catalogue has no topics for this subject yet. Add your own topics on top."
                  }
                />
              ) : (
                <TopicBranch
                  topics={topics}
                  subjectId={record.id}
                  institutionId={institutionId}
                />
              )}
            </div>
          </Card>

          {writable ? (
            <Card>
              <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Lifecycle</h3>
                  <p className="text-xs text-ink-muted">
                    {CATALOGUE_STATUS_HINTS[record.status]}
                  </p>
                </div>
                <SubjectStatusButton
                  subjectId={record.id}
                  status={record.status}
                  attachedTopics={record.topicCount}
                />
              </div>
            </Card>
          ) : (
            <Alert variant="info" title="Read-only catalogue content">
              Platform subjects are shared by every institution and cannot be
              edited or archived from here. Add your own subject if your school
              uses a different name.
            </Alert>
          )}
        </div>
      </main>
    </>
  );
}

function ProfileHeader({ name }: { name: string }) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">{name}</h1>
        <p className="text-sm text-ink-muted">Subject profile</p>
      </div>
      <Link href="/institution/subjects">
        <Button type="button" variant="ghost" size="sm">
          Back to subjects
        </Button>
      </Link>
    </header>
  );
}
