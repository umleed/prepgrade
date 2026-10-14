import type { Metadata } from "next";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { DemoRequestForm } from "@/components/marketing/demo-request-form";
import { CheckIcon } from "@/components/marketing/icons";

export const metadata: Metadata = {
  title: "Request a demo",
  description:
    "See PrepGrade with your own questions and classes. Tell us about your institution and we'll walk you through creating, delivering, and grading assessments end to end.",
};

const assurances = [
  "A walkthrough using your subjects and question style.",
  "Answers on setup, migration, and staff onboarding.",
  "A pilot plan for one class or a full term.",
];

export default function DemoRequestPage() {
  return (
    <div className="flex flex-1 flex-col">
      <SiteHeader activeHref="/pricing" />

      <main id="main" className="flex-1">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_1.2fr] lg:py-16">
          {/* Left rail — context and assurances. */}
          <section className="flex min-w-0 flex-col">
            <p className="text-xs font-bold uppercase tracking-widest text-brand">
              Request a demo
            </p>
            <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">
              See PrepGrade with your own exams
            </h1>
            <p className="mt-4 max-w-md text-base leading-7 text-ink-muted">
              Tell us a little about your institution and we&apos;ll arrange a
              practical walkthrough — from building a question bank to running a
              timed CBT and reading the analytics afterwards.
            </p>

            <ul className="mt-8 space-y-3">
              {assurances.map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-white">
                    <CheckIcon className="h-3 w-3" />
                  </span>
                  <span className="text-sm leading-6 text-ink-muted">
                    {item}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-8 rounded-card border border-border bg-surface-muted p-5">
              <p className="text-sm leading-6 text-ink-muted">
                Prefer to explore first? Browse{" "}
                <a
                  href="/pricing"
                  className="font-medium text-brand underline-offset-4 hover:underline"
                >
                  plans and pricing
                </a>{" "}
                or start an account directly from the{" "}
                <a
                  href="/register"
                  className="font-medium text-brand underline-offset-4 hover:underline"
                >
                  sign-up page
                </a>
                .
              </p>
            </div>
          </section>

          {/* Right rail — the form. */}
          <section
            aria-label="Demo request form"
            className="min-w-0 rounded-card border border-border bg-surface p-6 shadow-card sm:p-8"
          >
            <h2 className="text-lg font-bold tracking-tight text-ink">
              Tell us about your institution
            </h2>
            <p className="mt-1 text-sm leading-6 text-ink-muted">
              Fields marked with an asterisk (*) are required.
            </p>
            <div className="mt-6">
              <DemoRequestForm />
            </div>
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
