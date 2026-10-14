import type { Metadata } from "next";
import { connection } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { PlatformSidebar } from "@/components/platform/platform-sidebar";
import { PlatformHeader } from "@/components/platform/platform-header";

export const metadata: Metadata = {
  title: {
    default: "Platform",
    template: "%s | Platform | PrepGrade",
  },
  description: "PrepGrade platform operations for authorised super admins.",
};

// Reads the live session for authorization — never prerendered.
export const instant = false;

/**
 * Platform (super-admin) workspace layout — prompt 31.
 *
 * Server-side authorization is enforced HERE, on every request under
 * /platform: `requireSuperAdmin` resolves the role from trusted server-side
 * data (Clerk privateMetadata today — see lib/auth/context.ts for the trust
 * caveat) and redirects any other role to the shared dashboard, recording the
 * denied attempt in the platform audit log. Individual pages re-check via
 * their own guard call (defense in depth, same pattern as /institution).
 * Tenant workspaces remain separate: SUPER_ADMIN holds no tenant-area access
 * (ROLE_AREAS), and this layout grants no tenant data.
 */
export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();

  const principal = await requireSuperAdmin({ next: "/platform" });

  // Presentation-only identity (never an authorization input); null-safe
  // fallbacks, no invented names.
  const context = await getAuthContext();
  const userName =
    context.displayName ?? context.email ?? `Super admin (${principal.userId})`;

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <PlatformSidebar userName={userName} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PlatformHeader userName={userName} />
        {children}
      </div>
    </div>
  );
}
