import type { Metadata } from "next";
import { connection } from "next/server";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getSubscriptionPlansProbe } from "@/lib/data/platform-plans";
import { resolvePlansViewState } from "@/lib/plans";
import { Alert, Breadcrumbs, Card, EmptyState } from "@/components/ui";
import { CardIcon } from "@/components/platform/icons";

export const metadata: Metadata = {
  title: "Subscription Plans",
};

// Reads the live session and runs a live probe — never prerendered.
export const instant = false;

/**
 * Subscription Plans — Super Admin screen for the commercial plans PrepGrade
 * offers to institutions (design reference: "Billing & Subscriptions >
 * Subscription Plans").
 *
 * HONEST STATE ONLY. The schema has no plan table, no entitlement/quota
 * model, and no subscriber links yet, and no payment integration exists —
 * billing is a future phase (prompt 46). The design's prices, limits, plan
 * cards, revenue metrics, and Create/Edit/Archive actions are therefore NOT
 * rendered: showing them would fabricate a billing system. Instead this
 * screen probes the database live (lib/data/platform-plans.ts) and renders
 * whichever truth comes back, keeping the four states clearly distinct:
 *   - unavailable (no plan data model yet)  — what is true today,
 *   - data-source error                     — count unknown, never guessed,
 *   - genuinely empty catalogue             — real zero rows,
 *   - plans stored but not yet managed here — real count, no invented rows.
 *
 * Authorization: SUPER_ADMIN only, enforced server-side in the platform
 * layout and again here before the cross-tenant probe runs. There are no
 * write actions to protect until the plan schema and business rules exist.
 */
export default async function SubscriptionPlansPage() {
  await connection();

  // Guard first, outside any data access (same ordering as the directory).
  await requireSuperAdmin({ next: "/platform/subscription-plans" });

  const probe = await getSubscriptionPlansProbe();
  const view = resolvePlansViewState(probe);

  return (
    <main className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <Breadcrumbs
          items={[
            { label: "Platform", href: "/platform" },
            { label: "Subscription Plans" },
          ]}
        />

        {/* Page title block. No "Create Plan" action: plan creation is not
            supported until the schema and entitlement rules exist, so the
            button would be a lie. */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink lg:text-3xl">
            Subscription Plans
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Plans and pricing offered to educational institutions on
            PrepGrade. Every figure below reflects the live database state —
            nothing is shown until real plan data exists.
          </p>
        </div>

        {view.kind === "notImplemented" ? (
          <EmptyState
            icon={<CardIcon className="h-5 w-5" />}
            title="Subscription plans are not yet available"
            description={
              <>
                The database has no plan records — billing and subscriptions
                are a future phase, so there are no prices, limits, or
                subscriber counts to display. Before this screen can manage
                plans, the platform needs: a plan &amp; entitlement schema
                (an approved migration), quota rules wired to the
                enforcement model, and, if money will move, an approved
                payment-integration scope.{" "}
                <span className="font-medium text-ink">
                  This is an unavailable feature, not an empty plan list.
                </span>
              </>
            }
          />
        ) : null}

        {view.kind === "dataSourceError" ? (
          <Alert variant="danger" title="Plans unavailable">
            The plan catalogue could not be read right now, so its contents
            are unknown — not empty, not zero. Check the server&apos;s
            Supabase configuration and reload to try again.
          </Alert>
        ) : null}

        {view.kind === "noPlans" ? (
          <EmptyState
            icon={<CardIcon className="h-5 w-5" />}
            title="No plans defined yet"
            description="The plan catalogue exists and genuinely holds zero
              plans — a real empty state. Plan creation is not offered here
              yet: entitlement rules and quota enforcement must be defined
              and approved before commercial plans can be authored."
          />
        ) : null}

        {view.kind === "storedNotManaged" ? (
          <Card>
            <div className="flex flex-col gap-3 p-5">
              <h2 className="text-base font-semibold text-ink">
                {view.planCount.toLocaleString()} plan{" "}
                {view.planCount === 1 ? "record" : "records"} in the database
              </h2>
              <p className="text-sm leading-6 text-ink-muted">
                Plan rows exist, but this screen does not yet list or manage
                them: the plan schema, entitlement semantics, and the rules
                for how plan changes affect existing subscribers must be
                implemented and reviewed before details, edits, archiving,
                or activation can be shown truthfully. No sample plans are
                rendered in the meantime.
              </p>
            </div>
          </Card>
        ) : null}

        {/* Trust note — same transparency as the platform overview. */}
        <p className="text-xs leading-5 text-ink-subtle">
          The state above comes from a live server-side count against the
          platform database, run only for an authorised SUPER_ADMIN. No
          prices, currencies, limits, or subscriber counts are displayed
          unless they exist in real records.
        </p>
      </div>
    </main>
  );
}
