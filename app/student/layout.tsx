import type { Metadata } from "next";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth/context";
import { roleLabel } from "@/lib/auth/roles";
import { StudentSidebar } from "@/components/student/student-sidebar";

export const metadata: Metadata = {
  title: {
    default: "Student portal",
    template: "%s | Student portal | PrepGrade",
  },
  description: "Your assigned assessments and exam schedule.",
};

// Reads the live session for authorization — never prerendered.
export const instant = false;

/**
 * Student workspace layout (prompt 20).
 *
 * Server-side authorization is enforced here: only the STUDENT role with a
 * valid tenant membership reaches /student — students and unassigned accounts
 * are redirected before any data renders (AGENTS.md §5: route hiding is not
 * protection). The dashboard is the landing route; My Exams (prompt 21),
 * results (prompts 23–25), and practice (prompt 30) will mount under this
 * same shell as they ship.
 */
export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();

  const principal = await requireRole(["STUDENT"], { next: "/student" });
  const context = await getAuthContext();

  // Display fallbacks are presentation-only; the institutionId is trusted
  // server data used for scoping queries in child pages.
  const institutionName = principal.institutionId ?? "Your Institution";
  const studentName =
    context.displayName || context.email || "Student";

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <StudentSidebar
        institutionName={institutionName}
        roleLabel={roleLabel(principal.role)}
        studentName={studentName}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
