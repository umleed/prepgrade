"use client";

import type { ReactNode } from "react";
import { RoleShell } from "@/components/shell/role-shell";
import {
  INSTITUTION_EXAM_PREP_NAV,
  INSTITUTION_MAIN_NAV,
} from "@/lib/navigation/institution-nav";

/**
 * Institution Admin workspace frame.
 *
 * The responsive behaviour (persistent collapsible rail on desktop, top-bar +
 * modal drawer on tablet/mobile), the icon registry, and the active-state rule
 * all live in the shared `RoleShell` — the same engine that now drives the
 * Teacher and Student workspaces too. This file only supplies the institution
 * specifics: its two nav groups, the signed-in administrator's identity, and a
 * stable collapse-preference key.
 *
 * `institutionName` and `adminName` are resolved server-side by the layout from
 * trusted records; nothing here decides access.
 */
const INSTITUTION_COLLAPSE_STORAGE_KEY = "prepgrade.institution.sidebar.collapsed";

export function InstitutionShell({
  institutionName,
  adminName,
  children,
}: {
  /** Real institution name resolved server-side from trusted records. */
  institutionName: string;
  /** Current administrator's display name, resolved server-side. */
  adminName: string;
  children: ReactNode;
}) {
  return (
    <RoleShell
      institutionName={institutionName}
      roleLabel="Institution admin"
      sections={[
        { items: INSTITUTION_MAIN_NAV },
        { heading: "Exam Preparation", items: INSTITUTION_EXAM_PREP_NAV },
      ]}
      collapseStorageKey={INSTITUTION_COLLAPSE_STORAGE_KEY}
      navAriaLabel="Institution navigation"
      user={{ name: adminName }}
    >
      {children}
    </RoleShell>
  );
}
