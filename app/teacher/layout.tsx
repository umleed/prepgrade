import type { Metadata } from "next";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { roleLabel } from "@/lib/auth/roles";
import { institutionDisplayText } from "@/lib/auth/institution-identity";
import { getInstitutionIdentity } from "@/lib/data/institution-identity";
import { RoleShell } from "@/components/shell/role-shell";
import { TEACHER_MAIN_NAV } from "@/lib/navigation/teacher-nav";

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
 * The teacher dashboard (prompt 26) is the landing route; the question bank
 * (prompt 15) and exam views (prompts 17–19) mount under this same shell.
 */
export default async function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();

  // The teacher dashboard (prompt 26) is the workspace landing route.
  const principal = await requireRole(["TEACHER", "INSTITUTION_ADMIN"], {
    next: "/teacher",
  });

  // Real institution name, read from the trusted tenant id (never the UUID,
  // never a client-supplied id) — the same honest identity the shell shows.
  const identity = await getInstitutionIdentity({
    userId: principal.userId,
    institutionId: principal.institutionId,
  });
  const institutionName = institutionDisplayText(
    identity.status === "resolved" ? identity.name : null,
  );

  return (
    <RoleShell
      institutionName={institutionName}
      roleLabel={roleLabel(principal.role)}
      sections={[{ items: TEACHER_MAIN_NAV }]}
      collapseStorageKey="prepgrade.teacher.sidebar.collapsed"
      navAriaLabel="Teaching navigation"
      footerLink={{ label: "Back to my overview", href: "/dashboard" }}
    >
      {children}
    </RoleShell>
  );
}
