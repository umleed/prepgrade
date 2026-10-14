import { cn } from "@/lib/utils";
import {
  AnalyticsIcon,
  DocEditIcon,
  LogoMark,
  SchoolIcon,
  StudentIcon,
  TeacherIcon,
} from "./icons";

/**
 * A stylised, illustrative preview of the institution dashboard used in the
 * "Why PrepGrade" marketing section. Built from design tokens (not a real
 * screenshot), so the sample figures inside are demo data. Marked
 * `aria-hidden` because it is decorative.
 */

const sidebarItems = [
  { label: "Dashboard", active: true },
  { label: "Exams" },
  { label: "Questions" },
  { label: "Students" },
  { label: "Teachers" },
  { label: "Classes" },
];

const statCards = [
  { value: "1,240", label: "Students", delta: "↑ 12%", icon: StudentIcon, tone: "bg-brand-50 text-brand-700" },
  { value: "32", label: "Teachers", delta: "↑ 6%", icon: TeacherIcon, tone: "bg-accent-pink-soft text-accent-pink" },
  { value: "156", label: "Exams Conducted", delta: "↑ 24%", icon: DocEditIcon, tone: "bg-accent-green-soft text-accent-green" },
  { value: "78%", label: "Average Score", delta: "↑ 10%", icon: AnalyticsIcon, tone: "bg-accent-orange-soft text-accent-orange" },
];

export function DashboardPreview() {
  return (
    <div
      aria-hidden="true"
      className="select-none overflow-hidden rounded-card border border-border bg-surface shadow-raised"
    >
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex items-center gap-1.5 text-sm font-bold tracking-tight text-ink">
          <LogoMark className="h-5 w-5" />
          PrepGrade
        </span>
        <span className="ml-2 hidden h-7 flex-1 items-center rounded-field border border-border bg-surface-muted px-2.5 text-2xs text-ink-subtle sm:flex">
          Search anything...
        </span>
        <span className="hidden items-center gap-1.5 rounded-field border border-border px-2.5 py-1.5 text-2xs font-medium text-ink-muted md:flex">
          <SchoolIcon className="h-3.5 w-3.5 text-brand" />
          Greenwood International School
          <ChevronDown />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-2xs font-semibold text-brand-700">
            AS
          </span>
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="text-2xs font-semibold text-ink">Adeayo S.</span>
            <span className="text-[9px] text-ink-subtle">School Admin</span>
          </span>
        </span>
      </div>

      <div className="flex">
        {/* Sidebar */}
        <nav className="flex w-32 shrink-0 flex-col gap-1 bg-ink p-2.5 text-white/80 sm:w-40">
          {sidebarItems.map((item) => (
            <span
              key={item.label}
              className={cn(
                "rounded-field px-2.5 py-1.5 text-2xs font-medium",
                item.active ? "bg-brand text-white" : undefined,
              )}
            >
              {item.label}
            </span>
          ))}
        </nav>

        {/* Main panel */}
        <div className="min-w-0 flex-1 bg-canvas p-3 sm:p-4">
          <p className="text-sm font-semibold text-ink">Dashboard</p>

          <div className="mt-2.5 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {statCards.map((stat) => (
              <div
                key={stat.label}
                className="flex min-w-0 items-center gap-2 rounded-field border border-border bg-surface p-2"
              >
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                    stat.tone,
                  )}
                >
                  <stat.icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-ink">
                    {stat.value}
                  </span>
                  <span className="block truncate text-[9px] text-ink-subtle">
                    {stat.label}
                  </span>
                  <span className="block text-[9px] font-medium text-success">
                    {stat.delta}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            {/* Recent exams panel */}
            <div className="min-w-0 rounded-field border border-border bg-surface p-3">
              <div className="flex items-center justify-between">
                <p className="text-2xs font-semibold text-ink">
                  Recent Exams
                </p>
                <span className="text-[9px] font-medium text-brand">
                  View all
                </span>
              </div>
              <ul className="mt-2 space-y-1.5">
                {[
                  { name: "SS2 Mathematics — Mid Term", status: "Graded", tone: "bg-success-soft text-success-strong" },
                  { name: "JAMB Physics Mock — Paper 1", status: "In progress", tone: "bg-info-soft text-info-strong" },
                  { name: "WAEC Chemistry Practical Prep", status: "Scheduled", tone: "bg-surface-muted text-ink-muted" },
                ].map((exam) => (
                  <li
                    key={exam.name}
                    className="flex items-center justify-between gap-2 rounded-md bg-surface-muted px-2 py-1.5"
                  >
                    <span className="truncate text-[10px] text-ink-muted">
                      {exam.name}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-medium",
                        exam.tone,
                      )}
                    >
                      {exam.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Performance trend panel */}
            <div className="min-w-0 rounded-field border border-border bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-2xs font-semibold text-ink">
                  Performance Trend
                </p>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="rounded-md border border-border px-1.5 py-0.5 text-[9px] text-ink-muted">
                  This Term
                </span>
                <span className="rounded-md border border-border px-1.5 py-0.5 text-[9px] text-ink-muted">
                  All Subjects
                </span>
              </div>
              {/* Simple sparkline */}
              <svg
                viewBox="0 0 100 44"
                preserveAspectRatio="none"
                className="mt-2 h-14 w-full text-brand"
              >
                <polyline
                  points="2,36 14,30 26,32 38,24 50,26 62,16 74,19 86,10 98,6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <polygon
                  points="2,36 14,30 26,32 38,24 50,26 62,16 74,19 86,10 98,6 98,44 2,44"
                  fill="currentColor"
                  opacity="0.08"
                />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      className="h-3 w-3"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
