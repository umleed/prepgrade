import type { Metadata } from "next";
import { Button } from "@/components/ui";
import { DashboardPreview } from "@/components/marketing/dashboard-preview";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { PricingPlans } from "@/components/marketing/pricing-plans";
import {
  ArrowRightIcon,
  CheckIcon,
  ShieldIcon,
  BoltIcon,
  UsersIcon,
} from "@/components/marketing/icons";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Flexible PrepGrade plans for students, teachers, schools, and tutorial centres. Understand what drives pricing and request a demo tailored to your institution.",
};

const heroAssurances = [
  { icon: UsersIcon, label: "No long-term contract" },
  { icon: BoltIcon, label: "Quick setup and onboarding" },
  { icon: ShieldIcon, label: "Secure & reliable platform" },
];

const pricingFactors = [
  {
    title: "Institution size",
    detail:
      "Larger schools and multi-branch groups need more configuration, roles, and support than a single classroom.",
  },
  {
    title: "Student capacity",
    detail:
      "The number of learners you enrol determines how many accounts and attempts your plan needs to cover.",
  },
  {
    title: "Assessment volume",
    detail:
      "How many exams and mock sessions you run each term affects the storage and processing you'll want included.",
  },
  {
    title: "Enabled features",
    detail:
      "Advanced analytics, integrations, and onboarding are optional so you only pay for what you actually use.",
  },
];

const faqs = [
  {
    q: "Are these the final prices?",
    a: "No. The figures shown are indicative pilot prices to help you estimate. Your final pricing is confirmed with us directly and depends on the factors above.",
  },
  {
    q: "Can we start with one class?",
    a: "Yes. Most institutions begin with a pilot — a single class or a single term — and expand once the workflow is proven.",
  },
  {
    q: "Do you support tutorial centres?",
    a: "Absolutely. The School / Tutorial Centre plan covers multi-teacher accounts, student management, and custom CBT exams.",
  },
  {
    q: "Is there a contract?",
    a: "There is no long-term lock-in for pilot plans. Enterprise arrangements are tailored and discussed during the demo.",
  },
];

export default function PricingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <SiteHeader activeHref="/pricing" />

      <main id="main" className="flex-1">
        {/* Hero */}
        <section className="border-b border-border bg-surface">
          <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:py-16">
            <div className="flex min-w-0 flex-col items-start gap-5">
              <p className="rounded-full bg-brand-50 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-brand-700">
                Simple Pricing for Every Institution
              </p>
              <h1 className="text-4xl font-bold leading-[1.05] tracking-tight text-ink sm:text-5xl">
                Flexible plans for{" "}
                <span className="text-brand">schools, tutorial centres</span> and
                students.
              </h1>
              <p className="max-w-xl text-lg leading-8 text-ink-muted">
                Choose a plan that fits your needs. Start small, scale as you
                grow. PrepGrade offers flexible pricing for schools, tutorial
                centres, teachers, and individual students — every plan includes
                secure CBT, powerful analytics, and access to the question bank.
              </p>
              <ul className="mt-1 flex flex-wrap gap-x-6 gap-y-3">
                {heroAssurances.map((item) => (
                  <li
                    key={item.label}
                    className="flex items-center gap-2 text-sm text-ink-muted"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success-soft text-success-strong">
                      <CheckIcon className="h-4 w-4" />
                    </span>
                    {item.label}
                  </li>
                ))}
              </ul>
            </div>

            <div className="min-w-0">
              <DashboardPreview />
            </div>
          </div>
        </section>

        {/* Plans + comparison */}
        <section aria-labelledby="plans-heading" className="scroll-mt-20">
          <div className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6">
            <h2 id="plans-heading" className="sr-only">
              Plans and comparison
            </h2>
            <PricingPlans />
          </div>
        </section>

        {/* What determines your price */}
        <section
          aria-labelledby="factors-heading"
          className="border-y border-border bg-surface"
        >
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-widest text-brand">
                How pricing works
              </p>
              <h2
                id="factors-heading"
                className="mt-3 text-2xl font-bold tracking-tight text-ink sm:text-3xl"
              >
                What determines your price
              </h2>
              <p className="mt-3 text-base leading-7 text-ink-muted">
                PrepGrade pricing is tailored rather than one-size-fits-all. The
                amounts on this page are indicative starting points; your final
                quote reflects the shape of your institution.
              </p>
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {pricingFactors.map((factor) => (
                <div
                  key={factor.title}
                  className="rounded-card border border-border bg-canvas p-5"
                >
                  <h3 className="text-base font-semibold text-ink">
                    {factor.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-ink-muted">
                    {factor.detail}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-6 max-w-3xl text-sm leading-6 text-ink-subtle">
              These figures are illustrative pilot pricing, not committed list
              prices, and may change before general availability. Contact us for
              a quote specific to your institution.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section aria-labelledby="faq-heading">
          <div className="mx-auto w-full max-w-4xl px-4 py-16 sm:px-6">
            <h2
              id="faq-heading"
              className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
            >
              Frequently asked questions
            </h2>
            <div className="mt-8 space-y-3">
              {faqs.map((item) => (
                <details
                  key={item.q}
                  className="group rounded-card border border-border bg-surface px-5 py-4 shadow-card"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-open:rotate-180"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </summary>
                  <p className="mt-3 text-sm leading-6 text-ink-muted">
                    {item.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section aria-labelledby="pricing-cta-heading">
          <div className="mx-auto w-full max-w-7xl px-4 pb-20 sm:px-6">
            <div className="rounded-card border border-brand-200 bg-brand-50 px-6 py-12 text-center sm:px-12">
              <h2
                id="pricing-cta-heading"
                className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
              >
                Not sure which plan fits?
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-base leading-7 text-ink-muted">
                Tell us about your institution and we&apos;ll recommend a plan —
                or build a tailored quote for a larger deployment.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <Button href="/demo-request" variant="primary" size="lg">
                  Request a demo
                  <ArrowRightIcon className="h-4 w-4" />
                </Button>
                <Button href="/register" variant="secondary" size="lg">
                  Get started
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
