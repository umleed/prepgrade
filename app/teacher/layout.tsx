import type { Metadata } from "next";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { roleLabel } from "@/lib/auth/roles";
import { TeacherSidebar } from "@/components/teacher/teacher-sidebar";

export const metadata: Metadata = {
  title: {
    default: "Teaching workspace",
    template: "%s | Teaching workspace | PrepGrade",
  },
  description: "Build your question bank and prepare assessments.",
};

// Reads the live session for authorization — never prerendered.
export const instant = false;

/**
 * Teaching workspace layout (prompt 15 onward).
 *
 * Server-side authorization is enforced here: TEACHER and INSTITUTION_ADMIN
 * members with a valid tenant can access routes under /teacher — both roles
 * hold `question.manage`, and `ROLE_AREAS` grants admins the teaching area
 * too. Students and unassigned accounts are redirected before any data
 * renders; the sidebar's disabled items are presentation, not protection.
 * The question bank (prompt 15) is the first screen; the teacher dashboard
 * (prompt 26) and exam views (prompt 17) will mount under this same shell.
 */
export default async function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();

  // The question bank is the first screen of this workspace; when the
  // teacher dashboard ships (prompt 26) it becomes the landing route.
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher/questions",
  });

  // Display fallbacks are presentation-only; the institutionId is trusted
  // server data used for scoping queries in child pages.
  const institutionName = principal.institutionId ?? "Your Institution";

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <TeacherSidebar
        institutionName={institutionName}
        roleLabel={roleLabel(principal.role)}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
