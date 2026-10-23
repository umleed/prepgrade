import type { Metadata } from "next";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth/context";
import { roleLabel } from "@/lib/auth/roles";
import { SIGN_OUT_REDIRECT_URL } from "@/lib/auth/access";
import { institutionDisplayText } from "@/lib/auth/institution-identity";
import { getInstitutionIdentity } from "@/lib/data/institution-identity";
import { RoleShell } from "@/components/shell/role-shell";
import { STUDENT_MAIN_NAV } from "@/lib/navigation/student-nav";
import { SignOutButton } from "@clerk/nextjs";

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

  // Real institution name, read from the trusted tenant id (never the UUID,
  // never a client-supplied id) — the same honest identity the shell shows.
  const identity = await getInstitutionIdentity({
    userId: principal.userId,
    institutionId: principal.institutionId,
  });
  const institutionName = institutionDisplayText(
    identity.status === "resolved" ? identity.name : null,
  );
  const studentName = context.displayName || context.email || "Student";

  return (
    <RoleShell
      institutionName={institutionName}
      roleLabel={roleLabel(principal.role)}
      sections={[{ items: STUDENT_MAIN_NAV }]}
      collapseStorageKey="prepgrade.student.sidebar.collapsed"
      navAriaLabel="Student navigation"
      user={{ name: studentName }}
      footerSlot={
        <SignOutButton redirectUrl={SIGN_OUT_REDIRECT_URL}>
          <button
            type="button"
            className="text-xs text-ink-muted hover:text-ink hover:underline"
          >
            Sign out
          </button>
        </SignOutButton>
      }
    >
      {children}
    </RoleShell>
  );
}
