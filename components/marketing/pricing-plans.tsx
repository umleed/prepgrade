"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { ArrowRightIcon, CheckIcon } from "./icons";
import { cn } from "@/lib/utils";

/*
 * Pricing plans + feature comparison.
 *
 * NOTE ON PRICES: The figures below are INDICATIVE pilot prices taken from the
 * approved design (Pricing_screen). They are NOT final, approved list prices.
 * Per prompt 04, PrepGrade does not yet publish committed pricing — final cost
 * depends on institution size, student capacity, assessment volume, and enabled
 * features (see the explainer on the page). Replace or remove these numbers once
 * pricing is approved, and keep them consistent with the disclaimer copy.
 */

type TierId = "student" | "teacher" | "school" | "enterprise";

type Tier = {
  id: TierId;
  name: string;
  audience: string;
  /** Monthly price in Naira, or null for custom-priced tiers. */
  monthly: number | null;
  priceNote?: string;
  features: string[];
  cta: { label: string; href: string; variant: "primary" | "secondary" };
  popular?: boolean;
};

const tiers: Tier[] = [
  {
    id: "student",
    name: "Student",
    audience: "For individual learners",
    monthly: 2000,
    features: [
      "Access to JAMB, WAEC & NECO practice",
      "Subject-based question banks",
      "Personal performance analytics",
      "Practice mode and mock exams",
    ],
    cta: { label: "Get Started", href: "/register", variant: "primary" },
  },
  {
    id: "teacher",
    name: "Teacher",
    audience: "For individual teachers",
    monthly: 5000,
    features: [
      "Create and manage assessments",
      "Assign to your students",
      "Automatic grading and analytics",
      "Question bank access",
      "Track student performance",
    ],
    cta: { label: "Get Started", href: "/register", variant: "secondary" },
  },
  {
    id: "school",
    name: "School / Tutorial Centre",
    audience: "For schools, centres and institutions",
    monthly: 25000,
    priceNote: "Starting price • Scales with number of students",
    features: [
      "Everything in Teacher plan",
      "Multi-teacher accounts",
      "Student management",
      "Institution dashboard and analytics",
      "Custom CBT and school exams",
      "Role-based access and permissions",
    ],
    cta: {
      label: "Get Started",
      href: "/register",
      variant: "primary",
    },
    popular: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    audience: "For large institutions & groups",
    monthly: null,
    priceNote: "Tailored to your needs",
    features: [
      "Everything in School plan",
      "Dedicated support",
      "Custom integrations",
      "Advanced security and compliance",
      "Multi-branch management",
      "Onboarding and training",
    ],
    cta: { label: "Contact Sales", href: "/demo-request", variant: "secondary" },
  },
];

/** Annual billing discount shown in the design ("Save up to 20%"). */
const ANNUAL_DISCOUNT = 0.2;

type BillingCycle = "monthly" | "yearly";

function formatNaira(amount: number): string {
  return `₦${Math.round(amount).toLocaleString("en-NG")}`;
}

const comparisonFeatures: Array<{
  label: string;
  support: Record<TierId, boolean>;
}> = [
  {
    label: "Access to JAMB, WAEC & NECO practice",
    support: { student: true, teacher: true, school: true, enterprise: true },
  },
  {
    label: "Subject-based question banks",
    support: { student: true, teacher: true, school: true, enterprise: true },
  },
  {
    label: "Personal performance analytics",
    support: { student: true, teacher: true, school: true, enterprise: true },
  },
  {
    label: "Practice mode and mock exams",
    support: { student: true, teacher: true, school: true, enterprise: true },
  },
  {
    label: "Create and deliver custom CBT exams",
    support: { student: false, teacher: true, school: true, enterprise: true },
  },
  {
    label: "Assign exams to students",
    support: { student: false, teacher: true, school: true, enterprise: true },
  },
  {
    label: "Automatic grading and analytics",
    support: { student: false, teacher: true, school: true, enterprise: true },
  },
  {
    label: "Multi-teacher accounts",
    support: { student: false, teacher: false, school: true, enterprise: true },
  },
  {
    label: "Student management",
    support: { student: false, teacher: false, school: true, enterprise: true },
  },
  {
    label: "Institution dashboard and analytics",
    support: { student: false, teacher: false, school: true, enterprise: true },
  },
  {
    label: "Role-based access and permissions",
    support: { student: false, teacher: false, school: true, enterprise: true },
  },
  {
    label: "Dedicated support",
    support: { student: false, teacher: false, school: false, enterprise: true },
  },
  {
    label: "Custom integrations",
    support: { student: false, teacher: false, school: false, enterprise: true },
  },
  {
    label: "Multi-branch management",
    support: { student: false, teacher: false, school: false, enterprise: true },
  },
  {
    label: "Onboarding and training",
    support: { student: false, teacher: false, school: false, enterprise: true },
  },
];

function BillingToggle({
  cycle,
  onChange,
}: {
  cycle: BillingCycle;
  onChange: (cycle: BillingCycle) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Billing period"
      className="inline-flex items-center gap-1 rounded-full border border-border bg-surface p-1 shadow-card"
    >
      <button
        type="button"
        aria-pressed={cycle === "monthly"}
        onClick={() => onChange("monthly")}
        className={cn(
          "rounded-full px-5 py-2 text-sm font-medium transition-colors",
          cycle === "monthly"
            ? "bg-brand text-white"
            : "text-ink-muted hover:text-ink",
        )}
      >
        Monthly
      </button>
      <button
        type="button"
        aria-pressed={cycle === "yearly"}
        onClick={() => onChange("yearly")}
        className={cn(
          "flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors",
          cycle === "yearly"
            ? "bg-brand text-white"
            : "text-ink-muted hover:text-ink",
        )}
      >
        Yearly
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-2xs font-semibold",
            cycle === "yearly"
              ? "bg-white/20 text-white"
              : "bg-success-soft text-success-strong",
          )}
        >
          Save up to 20%
        </span>
      </button>
    </div>
  );
}

function PriceDisplay({
  tier,
  cycle,
}: {
  tier: Tier;
  cycle: BillingCycle;
}) {
  if (tier.monthly === null) {
    return (
      <div>
        <p className="text-3xl font-bold tracking-tight text-ink">
          Custom Pricing
        </p>
        {tier.priceNote ? (
          <p className="mt-1 text-sm text-ink-muted">{tier.priceNote}</p>
        ) : null}
      </div>
    );
  }

  const perMonth =
    cycle === "yearly" ? tier.monthly * (1 - ANNUAL_DISCOUNT) : tier.monthly;

  return (
    <div>
      <p className="flex items-baseline gap-1">
        <span className="text-3xl font-bold tracking-tight text-ink">
          {formatNaira(perMonth)}
        </span>
        <span className="text-sm text-ink-muted">/ month</span>
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        {cycle === "yearly"
          ? `Billed ${formatNaira(perMonth * 12)} annually`
          : tier.priceNote ?? "Billed monthly"}
      </p>
    </div>
  );
}

function TierCard({ tier, cycle }: { tier: Tier; cycle: BillingCycle }) {
  return (
    <div
      className={cn(
        "relative flex h-full flex-col rounded-card border bg-surface p-6 shadow-card",
        tier.popular ? "border-brand ring-1 ring-brand" : "border-border",
      )}
    >
      {tier.popular ? (
        <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-2xs font-semibold text-white shadow-card">
          Most Popular
        </span>
      ) : null}

      <h3 className="text-lg font-bold text-ink">{tier.name}</h3>
      <p className="mt-1 text-sm text-ink-muted">{tier.audience}</p>

      <div className="mt-5">
        <PriceDisplay tier={tier} cycle={cycle} />
      </div>

      <ul className="mt-6 flex flex-1 flex-col gap-3">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
              <CheckIcon className="h-3.5 w-3.5" />
            </span>
            <span className="text-sm leading-6 text-ink-muted">{feature}</span>
          </li>
        ))}
      </ul>

      <Button
        href={tier.cta.href}
        variant={tier.cta.variant}
        size="lg"
        className="mt-6 w-full"
      >
        {tier.cta.label}
        {tier.popular ? <ArrowRightIcon className="h-4 w-4" /> : null}
      </Button>
    </div>
  );
}

function ComparisonCell({ supported }: { supported: boolean }) {
  if (!supported) {
    return (
      <td className="px-4 py-3 text-center">
        <span className="text-ink-subtle" aria-label="Not included">
          —
        </span>
      </td>
    );
  }
  return (
    <td className="px-4 py-3 text-center">
      <span
        className="mx-auto flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-brand-700"
        role="img"
        aria-label="Included"
      >
        <CheckIcon className="h-4 w-4" />
      </span>
    </td>
  );
}

export function PricingPlans() {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");

  return (
    <div className="flex flex-col gap-14">
      <div className="flex justify-center">
        <BillingToggle cycle={cycle} onChange={setCycle} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4 lg:items-stretch">
        {tiers.map((tier) => (
          <TierCard key={tier.id} tier={tier} cycle={cycle} />
        ))}
      </div>

      <section aria-labelledby="compare-heading">
        <h2
          id="compare-heading"
          className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
        >
          Compare plans
        </h2>
        <p className="mt-2 max-w-2xl text-base leading-7 text-ink-muted">
          A side-by-side look at what each plan includes.
        </p>

        <div className="mt-6 overflow-x-auto rounded-card border border-border bg-surface shadow-card">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <caption className="sr-only">
              Feature comparison across PrepGrade plans
            </caption>
            <thead>
              <tr className="border-b border-border bg-surface-muted">
                <th
                  scope="col"
                  className="px-4 py-3 text-left font-semibold text-ink"
                >
                  Feature
                </th>
                {tiers.map((tier) => (
                  <th
                    key={tier.id}
                    scope="col"
                    className="px-4 py-3 text-center font-semibold text-ink"
                  >
                    {tier.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparisonFeatures.map((row) => (
                <tr key={row.label} className="border-b border-border last:border-0">
                  <th
                    scope="row"
                    className="px-4 py-3 text-left font-normal text-ink-muted"
                  >
                    {row.label}
                  </th>
                  <ComparisonCell supported={row.support.student} />
                  <ComparisonCell supported={row.support.teacher} />
                  <ComparisonCell supported={row.support.school} />
                  <ComparisonCell supported={row.support.enterprise} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
