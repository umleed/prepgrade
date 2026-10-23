import Link from "next/link";
import {
  getExamPrep,
  type ExamPrepExam,
  type ExamPrepResult,
} from "@/lib/data/exam-prep";
import { examDisplayState } from "@/lib/exams";
import {
  INSTITUTION_EXAMS_NEW_PATH,
  INSTITUTION_EXAMS_PATH,
  INSTITUTION_QUESTION_BANK_PATH,
} from "@/lib/navigation/institution-nav";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

/**
 * Exam detail lives in the SHARED exam workspace (`/teacher/exams/…`), which
 * institution admins legitimately hold and which authorizes INSTITUTION_ADMIN
 * server-side on every page (see the routing contract in
 * lib/navigation/institution-nav.ts). The prep page stays in the Institution
 * shell for browsing; opening an exam is the same deep lifecycle the Exams list
 * uses — never a teacher-ONLY route.
 */
const EXAM_WORKSPACE_BASE = "/teacher/exams";

function StatCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card>
      <div className="p-5">
        <p className="text-sm font-medium text-ink-muted">{label}</p>
        <p className="mt-1 text-3xl font-bold tracking-tight text-ink">
          {value.toLocaleString()}
        </p>
        <p className="mt-1 text-2xs text-ink-subtle">{hint}</p>
      </div>
    </Card>
  );
}

function PrepExamRows({ exams }: { exams: ExamPrepExam[] }) {
  const now = new Date();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Exam</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {exams.map((exam) => {
          const display = examDisplayState(
            exam.status as Parameters<typeof examDisplayState>[0],
            exam.startsAt,
            exam.endsAt,
            now,
          );
          return (
            <TableRow key={exam.id}>
              <TableCell asHeader>
                <Link
                  href={`${EXAM_WORKSPACE_BASE}/${exam.id}`}
                  className="line-clamp-2 max-w-md font-medium text-ink hover:text-brand-700 hover:underline"
                >
                  {exam.title}
                </Link>
              </TableCell>
              <TableCell>{exam.subjectName}</TableCell>
              <TableCell>
                <Badge tone={display.tone} dot>
                  {display.label}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Link href={`${EXAM_WORKSPACE_BASE}/${exam.id}`}>
                  <Button type="button" variant="secondary" size="sm">
                    View
                  </Button>
                </Link>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Honest, non-fabricated states when a category's data cannot be shown. */
function CategoryFallback({ code }: { code: string }) {
  return (
    <Alert variant="danger" title={`${code} data is unavailable`}>
      The {code} exams and questions could not be loaded. This is expected until
      the subjects, questions, and exams migrations are applied to your Supabase
      project (<span className="font-mono">supabase/migrations</span>). No
      content is shown to avoid presenting anything that has not been created.
    </Alert>
  );
}

/**
 * Renders one examination-preparation category (JAMB / WAEC / NECO) inside the
 * Institution shell. Reads REAL tenant data via the trusted `institutionId` and
 * the platform `exam_categories` code, and shows honest empty states — an
 * institution with nothing filed under a category sees an invitation to create,
 * never fabricated sample content.
 */
export async function ExamPrepContent({
  institutionId,
  code,
  label,
  basePath,
}: {
  institutionId: string;
  /** Platform category code: "JAMB" | "WAEC" | "NECO". */
  code: string;
  label: string;
  /** The page's own institution base, used to build back/again links. */
  basePath: string;
}) {
  const result: ExamPrepResult = await getExamPrep(institutionId, code);

  if (result.status === "unconfigured") {
    return (
      <Alert variant="warning" title={`${label} is not configured`}>
        Supabase connection variables are missing on the server. Set
        <span className="font-mono"> NEXT_PUBLIC_SUPABASE_URL </span>and
        <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY </span>to load
        this category.
      </Alert>
    );
  }

  if (result.status === "no-category") {
    return (
      <Alert variant="warning" title={`${label} is not an available category`}>
        There is no active <span className="font-mono">{code}</span> exam
        category yet. Categories come from the platform exam-category catalogue
        (the <span className="font-mono">exam_categories</span> table,
        migration 0005); apply the migrations to make {label} content available.
      </Alert>
    );
  }

  if (result.status === "unavailable") {
    return <CategoryFallback code={label} />;
  }

  const { exams, questionCount } = result;
  const hasContent = exams.length > 0 || questionCount > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label={`${label} exams`}
          value={exams.length}
          hint="Filed under this category"
        />
        <StatCard
          label={`${label} questions`}
          value={questionCount}
          hint="Active questions in your bank"
        />
      </div>

      {!hasContent ? (
        <EmptyState
          title={`No ${label} content yet`}
          description={`Nothing in your institution is filed under ${label} yet. Create an exam in this category, or add questions tagged ${label}, and they will appear here.`}
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Link href={INSTITUTION_EXAMS_NEW_PATH}>
                <Button type="button" variant="primary" size="sm">
                  Create a {label} exam
                </Button>
              </Link>
              <Link href={INSTITUTION_QUESTION_BANK_PATH}>
                <Button type="button" variant="secondary" size="sm">
                  Go to Question Bank
                </Button>
              </Link>
            </div>
          }
        />
      ) : exams.length === 0 ? (
        <Alert variant="info" title={`No ${label} exams yet`}>
          You have {questionCount.toLocaleString()} active {label}{" "}
          {questionCount === 1 ? "question" : "questions"} in your bank, but no
          exams in this category yet.
          <span className="ml-1 inline-flex flex-wrap gap-2">
            <Link href={INSTITUTION_EXAMS_NEW_PATH} className="font-medium text-brand-700 hover:underline">
              Create a {label} exam
            </Link>
          </span>
        </Alert>
      ) : (
        <PrepExamRows exams={exams} />
      )}

      <div className="flex flex-wrap gap-3 border-t border-border pt-4">
        <Link href={INSTITUTION_EXAMS_PATH}>
          <Button type="button" variant="ghost" size="sm">
            All exams
          </Button>
        </Link>
        <Link href={`${basePath}`}>
          <Button type="button" variant="ghost" size="sm">
            Refresh {label}
          </Button>
        </Link>
      </div>
    </div>
  );
}
