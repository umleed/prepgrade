import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { requireRole } from "@/lib/auth/guards";
import { institutionDisplayText } from "@/lib/auth/institution-identity";
import { getInstitutionIdentity } from "@/lib/data/institution-identity";
import { countTeachersByStatus } from "@/lib/data/teachers";
import { INSTITUTION_SETTINGS_PATH } from "@/lib/navigation/institution-nav";
import { Badge, Button, Card, EmptyState } from "@/components/ui";

export const metadata: Metadata = {
  title: "Dashboard",
};

// Reads the live session — never prerendered.
export const instant = false;

/**
 * Metric tile. Renders a real value when one is available, or a quiet "—" with
 * an explanatory caption when the underlying data source doesn't exist yet.
 * Numbers are never hardcoded (see the Implementation Notes in prompt 10).
 */
function MetricTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint: string;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-1 p-5">
        <p className="text-sm text-ink-muted">{label}</p>
        <p className="text-2xl font-bold tracking-tight text-ink">
          {value === null ? (
            <span aria-label="Not available yet">—</span>
          ) : (
            value.toLocaleString()
          )}
        </p>
        <p className="text-2xs leading-4 text-ink-subtle">{hint}</p>
      </div>
    </Card>
  );
}

/**
 * Quick-action tile linking to a workspace area. Areas whose pages ship in
 * later prompts render as disabled placeholders rather than dead links — the
 * same "don't link to what doesn't exist" rule the shared dashboard follows.
 */
function ActionTile({
  label,
  description,
  href,
}: {
  label: string;
  description: string;
  href: string | null;
}) {
  const classes =
    "flex flex-col gap-1 rounded-card border border-border bg-surface p-4 text-left shadow-card transition-colors";

  if (!href) {
    return (
      <span className={`${classes} cursor-not-allowed opacity-60`} aria-disabled="true">
        <span className="text-sm font-semibold text-ink">{label}</span>
        <span className="text-xs leading-5 text-ink-muted">{description}</span>
        <span className="mt-1 text-2xs font-medium text-ink-subtle">
          Coming in a later phase
        </span>
      </span>
    );
  }

  return (
    <Link href={href} className={`${classes} hover:border-border-strong`}>
      <span className="text-sm font-semibold text-ink">{label}</span>
      <span className="text-xs leading-5 text-ink-muted">{description}</span>
    </Link>
  );
}

/**
 * Institution admin dashboard — operational health and assessment performance
 * for the signed-in admin's own institution.
 *
 * Data status: the tenant schema (prompt 08) and the exam/attempt tables
 * (prompts 15–24) do not exist yet, so every metric renders its honest "no
 * data available" state instead of a fabricated number. Each query that does
 * land here must be scoped to `principal.institutionId` — the trusted tenant id
 * resolved server-side, never a client-supplied value (AGENTS.md §5).
 */
export default async function InstitutionDashboardPage() {
  await connection();

  // Authorization is enforced again here (defense in depth alongside the
  // layout): this page's queries must only ever run for an institution admin.
  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution",
  });

  const context = await getAuthContext();
  const adminName = context.displayName || context.email || "there";

  // The institution's real name, read from the trusted `institutions` record
  // (same resolution the sidebar shell uses). Never the tenant UUID.
  const identity = await getInstitutionIdentity({
    userId: principal.userId,
    institutionId: principal.institutionId,
  });
  const institutionName = institutionDisplayText(
    identity.status === "resolved" ? identity.name : null,
  );

  // Total Teachers is real once the teacher migration (prompt 12) is applied;
  // an unavailable data source stays "—" rather than showing an invented
  // number. The remaining metrics arrive with prompts 15–24 (exams/results)
  // and 28 (analytics) — do not replace those nulls with sample data.
  const totalStudents: number | null = null;
  let totalTeachers: number | null = null;
  try {
    const statusCounts = await countTeachersByStatus(principal.institutionId as string);
    totalTeachers = statusCounts.invited + statusCounts.active + statusCounts.inactive;
  } catch {
    totalTeachers = null;
  }
  const assessmentsConducted: number | null = null;
  const averageScore: number | null = null;

  return (
    <>
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Institution Dashboard
          </h1>
          <p className="text-sm text-ink-muted">
            Welcome back, {adminName}.
          </p>
          <p className="truncate text-sm font-medium text-ink" title={institutionName}>
            {institutionName}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="brand" dot>
            Institution Admin
          </Badge>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {/* Summary metrics — real data only; "—" until the schema ships. */}
          <section aria-labelledby="metrics-heading">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="metrics-heading" className="text-base font-semibold text-ink">
                Overview
              </h2>
              <p className="text-xs text-ink-subtle">
                Figures reflect your institution only.
              </p>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile
                label="Total Students"
                value={totalStudents}
                hint="Available once students are added"
              />
              <MetricTile
                label="Total Teachers"
                value={totalTeachers}
                hint="Invited, active, and deactivated teachers"
              />
              <MetricTile
                label="Assessments Conducted"
                value={assessmentsConducted}
                hint="Available once exams have been run"
              />
              <MetricTile
                label="Average Score"
                value={averageScore}
                hint="Available once results are graded"
              />
            </div>
          </section>

          {/* Drill-down navigation to the areas this dashboard exists to feed. */}
          <section aria-labelledby="manage-heading">
            <h2 id="manage-heading" className="text-base font-semibold text-ink">
              Manage
            </h2>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ActionTile
                label="Students"
                description="Enrol and manage student accounts."
                href="/institution/students"
              />
              <ActionTile
                label="Teachers"
                description="Invite teachers and set their scope."
                href="/institution/teachers"
              />
              <ActionTile
                label="Classes"
                description="Organise students into classes and sessions."
                href="/institution/classes"
              />
              <ActionTile
                label="Exams"
                description="Create, schedule, and assign assessments."
                href="/institution/exams"
              />
              <ActionTile
                label="Results"
                description="Review submissions and student performance."
                href={null}
              />
              <ActionTile
                label="Analytics"
                description="Track class and institution-wide trends."
                href="/institution/analytics"
              />
            </div>
          </section>

          {/* Recent assessments — honest empty state, no mock rows. */}
          <section aria-labelledby="recent-heading">
            <h2 id="recent-heading" className="text-base font-semibold text-ink">
              Recent Assessments
            </h2>
            <div className="mt-3">
              <EmptyState
                title="No assessments yet"
                description={
                  <>
                    Assessments your institution creates and runs will appear
                    here with their status and results. The exam builder ships
                    in a later phase.
                  </>
                }
                action={
                  <Link href={INSTITUTION_SETTINGS_PATH}>
                    <Button type="button" variant="secondary" size="sm">
                      Review institution setup
                    </Button>
                  </Link>
                }
              />
            </div>
          </section>

          {/* Recent activity — same rule: nothing shown until there is something. */}
          <section aria-labelledby="activity-heading">
            <h2 id="activity-heading" className="text-base font-semibold text-ink">
              Recent Activity
            </h2>
            <Card className="mt-3">
              <div className="p-5">
                <p className="text-sm leading-6 text-ink-muted">
                  Activity from across your institution — new students, published
                  exams, and graded results — will appear here once those actions
                  are available. Nothing is shown until it actually happened.
                </p>
              </div>
            </Card>
          </section>

          {/* Tenant-scope note: explains how data is bounded, truthfully,
              without exposing the internal tenant id in user-facing UI. */}
          <p className="text-xs leading-5 text-ink-subtle">
            Signed in as the administrator of {institutionName}. Every figure
            and list on this page is scoped to this institution.
          </p>
        </div>
      </main>
    </>
  );
}
