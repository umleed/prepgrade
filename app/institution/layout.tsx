import type { Metadata } from "next";
import { connection } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { InstitutionSidebar } from "@/components/institution/institution-sidebar";

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
 * with a valid tenant can access any route under /institution. The sidebar is
 * a client component for active-route highlighting; the layout itself stays on
 * the server.
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

  // Display name fallbacks are presentation-only; the institutionId is trusted
  // server data used for scoping queries in child pages.
  const institutionName = principal.institutionId ?? "Your Institution";

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <InstitutionSidebar
        institutionName={institutionName}
        userName={institutionName}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
