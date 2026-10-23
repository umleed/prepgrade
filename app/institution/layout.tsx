import type { Metadata } from "next";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { getAuthContext } from "@/lib/auth/context";
import { institutionDisplayText } from "@/lib/auth/institution-identity";
import { getInstitutionIdentity } from "@/lib/data/institution-identity";
import { InstitutionShell } from "@/components/institution/institution-sidebar";

export const metadata: Metadata = {
  title: {
    default: "Institution",
    template: "%s | Institution | PrepGrade",
  },
  description: "Manage your institution's assessments and performance.",
};

// Reads the live session for authorization — never prerendered.
export const instant = false;

/**
 * Institution workspace layout.
 *
 * Server-side authorization is enforced here: only INSTITUTION_ADMIN members
 * with a valid tenant can access any route under /institution. The shell is a
 * client component for active-route highlighting and the responsive drawer;
 * the layout itself stays on the server.
 *
 * Identity: the sidebar shows the institution's REAL name, read from the
 * `institutions` record behind the trusted tenant id (never the UUID, and
 * never a client-supplied id). When the name cannot be resolved, the shell
 * renders an honest fallback and the data layer logs a server-side
 * diagnostic — no fabricated names.
 */
export default async function InstitutionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();

  const principal = await requireRole(["INSTITUTION_ADMIN"], {
    next: "/institution",
  });

  // Both reads use only the server-resolved principal; nothing a browser
  // controls (params, search, public metadata) participates in the lookup.
  const context = await getAuthContext();
  const identity = await getInstitutionIdentity({
    userId: principal.userId,
    institutionId: principal.institutionId,
  });

  const institutionName = institutionDisplayText(
    identity.status === "resolved" ? identity.name : null,
  );
  // The administrator's own name is presentation-only and stays separate from
  // the institution's name.
  const adminName = context.displayName || context.email || "Administrator";

  return (
    <InstitutionShell institutionName={institutionName} adminName={adminName}>
      {children}
    </InstitutionShell>
  );
}
