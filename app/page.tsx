import type { Metadata } from "next";
import Image from "next/image";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { DashboardPreview } from "@/components/marketing/dashboard-preview";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import {
  AnalyticsIcon,
  ArrowRightIcon,
  BoltIcon,
  CbtDeliveryIcon,
  DevicesIcon,
  DocEditIcon,
  PlayIcon,
  SchoolIcon,
  ShieldIcon,
  StarIcon,
  StudentIcon,
  TeacherIcon,
  UsersIcon,
} from "@/components/marketing/icons";

export const metadata: Metadata = {
  title: "Smarter Assessments. Brighter Futures.",
  description:
    "PrepGrade helps Nigerian schools, tutorial centres, teachers, and students create, deliver, and analyse examinations with ease — CBT, automatic grading, results, and student/class analytics.",
};

/*
 * NOTE: The trust metrics below ("500+ schools", "200,000+ students",
 * "1,000,000+ exams", "95% satisfaction", "4.8/5 from 120+ reviews") and the
 * "Used by" institution names come from the approved design and are
 * PLACEHOLDERS. They must be replaced with verified figures (or removed)
 * before public launch — see AGENTS.md §2 ("do not claim features/outcomes
 * that are not real") and prompt 03.
 */
const trustStats = [
  { value: "500+", label: "Schools Trust PrepGrade" },
  { value: "200,000+", label: "Students Assessed" },
  { value: "1,000,000+", label: "Exams Completed" },
  { value: "95%", label: "Customer Satisfaction" },
];

const features = [
  {
    icon: DocEditIcon,
    title: "Easy Exam Creation",
    detail: "Create and assign exams in minutes.",
    tile: "bg-brand-50 text-brand-600",
  },
  {
    icon: ShieldIcon,
    title: "Secure Online Tests",
    detail: "Reliable, safe, and cheating-resistant.",
    tile: "bg-accent-green-soft text-accent-green",
  },
  {
    icon: BoltIcon,
    title: "Instant Grading",
    detail: "Get accurate results immediately.",
    tile: "bg-accent-purple-soft text-accent-purple",
  },
  {
    icon: AnalyticsIcon,
    title: "Detailed Analytics",
    detail: "Identify strengths and weak areas.",
    tile: "bg-accent-orange-soft text-accent-orange",
  },
  {
    icon: UsersIcon,
    title: "For Schools, Teachers and Students",
    detail: "A complete assessment solution.",
    tile: "bg-accent-pink-soft text-accent-pink",
  },
  {
    icon: DevicesIcon,
    title: "Anywhere, Anytime",
    detail: "Works on all devices, even with low bandwidth.",
    tile: "bg-accent-teal-soft text-accent-teal",
  },
];

const workflowSteps = [
  { label: "Create", detail: "Build question banks and exams." },
  { label: "Deliver", detail: "Run reliable CBT for students." },
  { label: "Grade", detail: "Auto-grade objective responses." },
  { label: "Analyse", detail: "Turn results into insight." },
  { label: "Improve", detail: "Close the loop for learners." },
];

const audiences = [
  {
    id: "for-schools",
    icon: SchoolIcon,
    title: "For Schools",
    detail:
      "Give your institution a multi-tenant portal where admins manage teachers, students, classes, and assessments — with every institution's data kept separate.",
  },
  {
    id: "for-teachers",
    icon: TeacherIcon,
    title: "For Teachers",
    detail:
      "Create questions once, reuse and adapt them into exams, assign them to your classes, and let objective marking take care of itself.",
  },
  {
    id: "for-students",
    icon: StudentIcon,
    title: "For Students",
    detail:
      "Sit assigned exams on any device, track your results over time, and see exactly which topics need more attention.",
  },
];

const futureCapabilities = [
  {
    title: "AI-assisted question generation",
    detail:
      "Draft questions from a topic outline, with mandatory human review before anything reaches an exam.",
  },
  {
    title: "Adaptive mastery practice",
    detail:
      "Targeted practice that adjusts to each student's demonstrated strengths and gaps over time.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <SiteHeader />

      <main id="main" className="flex-1">
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                              */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-b border-border bg-surface">
          <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:gap-14 lg:py-20 xl:grid-cols-[1fr_1.05fr]">
            <div className="flex min-w-0 flex-col items-start gap-5">
              <p className="rounded-full bg-brand-50 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-brand-700">
                Assess <span className="mx-1">Analyse</span> Improve
              </p>
              <h1 className="text-4xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">
                Smarter
                <br />
                Assessments.
                <br />
                <span className="text-brand">Brighter Futures.</span>
              </h1>
              <p className="max-w-xl text-lg leading-8 text-ink-muted">
                PrepGrade helps schools and educators create, deliver and
                analyse examinations with ease. Save time, improve teaching,
                and unlock every student&apos;s potential.
              </p>
              <div className="mt-1 flex flex-wrap gap-3">
                <Button href="/register" variant="primary" size="lg">
                  Get Started
                  <ArrowRightIcon className="h-4 w-4" />
                </Button>
                <Button href="/demo-request" variant="secondary" size="lg">
                  <PlayIcon className="h-5 w-5 text-brand" />
                  Watch Demo
                </Button>
              </div>

              {/* Trust row — placeholder metrics, see note above. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-3">
                <Image
                  src="/images/trust-avatars.png"
                  alt=""
                  width={178}
                  height={42}
                  className="h-10 w-auto"
                />
                <div className="min-w-0">
                  <p className="text-sm text-ink-muted">
                    Trusted by <span className="font-bold text-ink">500+</span>{" "}
                    schools across Nigeria
                  </p>
                  <p className="mt-1 flex items-center gap-1.5">
                    <span
                      className="flex items-center gap-0.5 text-warning"
                      role="img"
                      aria-label="Rated 4.8 out of 5 stars"
                    >
                      <StarIcon />
                      <StarIcon />
                      <StarIcon />
                      <StarIcon />
                      <StarIcon />
                    </span>
                    <span className="text-sm font-semibold text-ink">
                      4.8/5
                    </span>
                    <span className="text-xs text-ink-subtle">
                      (120+ reviews)
                    </span>
                  </p>
                </div>
              </div>
            </div>

            {/* Hero visual — the approved design artwork: photo with its
                floating stat cards baked in (illustrative demo data). */}
            <div className="min-w-0">
              <Image
                src="/images/hero-students.png"
                alt="Students in school uniforms sitting a computer-based practice exam on laptops"
                width={916}
                height={509}
                priority
                className="h-auto w-full rounded-card"
              />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Feature strip                                                     */}
        {/* ---------------------------------------------------------------- */}
        <section
          id="features"
          aria-labelledby="features-heading"
          className="scroll-mt-20 border-b border-border"
        >
          <h2
            id="features-heading"
            className="sr-only"
          >
            Key capabilities
          </h2>
          <div className="mx-auto grid w-full max-w-7xl gap-x-6 gap-y-10 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-6">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="flex flex-col items-center gap-3 text-center"
              >
                <span
                  className={`flex h-14 w-14 items-center justify-center rounded-2xl ${feature.tile}`}
                >
                  <feature.icon className="h-6 w-6" />
                </span>
                <h3 className="text-sm font-bold text-ink">
                  {feature.title}
                </h3>
                <p className="text-xs leading-5 text-ink-muted">
                  {feature.detail}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Trust stats + institutions band                                   */}
        {/*    Placeholder figures — see note at the top of this file.        */}
        {/* ---------------------------------------------------------------- */}
        <section aria-label="PrepGrade adoption and partner institutions">
          <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6">
            <div className="grid gap-8 rounded-card bg-surface-muted p-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
              <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                {trustStats.map((stat) => (
                  <div key={stat.label}>
                    <dt className="sr-only">{stat.label}</dt>
                    <dd>
                      <span className="block text-2xl font-bold text-brand">
                        {stat.value}
                      </span>
                      <span className="mt-1 block text-sm text-ink-muted">
                        {stat.label}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>

              <div>
                <p className="text-xs font-medium text-ink-subtle">
                  Used by leading schools and tutorial centres
                </p>
                <ul className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-4">
                  <InstitutionLogo name="Greenwood" suffix="International School" mark="shield" />
                  <InstitutionLogo name="Royal Prep" suffix="Academy" mark="crest" />
                  <InstitutionLogo name="Excel Tutors" mark="triangle" />
                  <InstitutionLogo name="BrightPath" suffix="Colleges" mark="leaf" />
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Why PrepGrade + dashboard preview                                 */}
        {/* ---------------------------------------------------------------- */}
        <section
          id="why-prepgrade"
          aria-labelledby="why-heading"
          className="scroll-mt-20 border-b border-border bg-brand-50/60"
        >
          <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.3fr] lg:py-20">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-widest text-brand">
                Why PrepGrade
              </p>
              <h2
                id="why-heading"
                className="mt-3 text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl"
              >
                Built for better learning outcomes
              </h2>
              <p className="mt-4 max-w-md text-base leading-7 text-ink-muted">
                From question creation to performance analytics, PrepGrade
                gives schools and educators the tools to assess, understand,
                and improve learning — and every student&apos;s result is
                backed by data you can act on.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Question banks and an exam builder for fast, repeatable test creation.",
                  "CBT delivery with timed sessions and progressive answer saving.",
                  "Automatic grading for objective questions, on the server.",
                  "Analytics that surface weak topics by student, class, and subject.",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-white">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="h-3 w-3"
                      >
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                    </span>
                    <span className="text-sm leading-6 text-ink-muted">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="min-w-0">
              <DashboardPreview />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Core workflow                                                     */}
        {/* ---------------------------------------------------------------- */}
        <section
          id="workflow"
          aria-labelledby="workflow-heading"
          className="scroll-mt-20 border-b border-border bg-surface"
        >
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
            <h2
              id="workflow-heading"
              className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
            >
              One loop, five steps
            </h2>
            <p className="mt-2 max-w-2xl text-base leading-7 text-ink-muted">
              Every assessment your institution runs follows the same simple
              cycle — and PrepGrade supports each step.
            </p>

            <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {workflowSteps.map((step, index) => (
                <li key={step.label}>
                  <Card className="h-full">
                    <CardHeader>
                      <span className="font-mono text-xs text-brand">
                        0{index + 1}
                      </span>
                      <CardTitle className="flex items-center gap-2">
                        {step.label}
                        {index < workflowSteps.length - 1 ? (
                          <ArrowRightIcon
                            aria-hidden="true"
                            className="hidden h-4 w-4 text-ink-subtle lg:inline"
                          />
                        ) : null}
                      </CardTitle>
                      <CardDescription>{step.detail}</CardDescription>
                    </CardHeader>
                  </Card>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Audiences                                                         */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="audiences-heading">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
            <h2
              id="audiences-heading"
              className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
            >
              Built around the people who run exams
            </h2>

            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {audiences.map((audience) => (
                <Card key={audience.id} id={audience.id} className="h-full scroll-mt-24">
                  <CardHeader>
                    <span className="flex h-10 w-10 items-center justify-center rounded-field bg-brand-50 text-brand-700">
                      <audience.icon className="h-5 w-5" />
                    </span>
                    <CardTitle className="mt-2">{audience.title}</CardTitle>
                    <CardDescription>{audience.detail}</CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Future capabilities (clearly labelled)                            */}
        {/* ---------------------------------------------------------------- */}
        <section
          aria-labelledby="future-heading"
          className="border-y border-border bg-surface"
        >
          <div className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6">
            <h2
              id="future-heading"
              className="text-xl font-bold tracking-tight text-ink sm:text-2xl"
            >
              What&apos;s coming next
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted">
              We would rather be honest than impressive: these capabilities
              are on the roadmap, not in the product today.
            </p>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {futureCapabilities.map((item) => (
                <li key={item.title}>
                  <Card className="h-full">
                    <CardHeader>
                      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-2xs font-medium text-ink-muted">
                        <CbtDeliveryIcon className="h-3.5 w-3.5" />
                        Future capability
                      </span>
                      <CardTitle className="mt-1">{item.title}</CardTitle>
                      <CardDescription>{item.detail}</CardDescription>
                    </CardHeader>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Closing CTA                                                       */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="cta-heading">
          <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
            <div className="rounded-card border border-brand-200 bg-brand-50 px-6 py-12 text-center sm:px-12">
              <h2
                id="cta-heading"
                className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
              >
                See PrepGrade with your own questions
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-base leading-7 text-ink-muted">
                Tell us about your institution and we&apos;ll walk you through
                creating, delivering, and grading an assessment end to end.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <Button href="/demo-request" variant="primary" size="lg">
                  Request a demo
                  <ArrowRightIcon className="h-4 w-4" />
                </Button>
                <Button href="/pricing" variant="secondary" size="lg">
                  View pricing
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

/**
 * Grayscale placeholder institution lockups from the approved design.
 * Placeholder names — see the note at the top of this file.
 */
function InstitutionLogo({
  name,
  suffix,
  mark,
}: {
  name: string;
  suffix?: string;
  mark: "shield" | "crest" | "triangle" | "leaf";
}) {
  return (
    <li className="flex items-center gap-2 text-ink-muted">
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        className="h-6 w-6 opacity-70"
      >
        {mark === "shield" ? (
          <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 4.2 3 2.1v3.3l-3 2-3-2V8.3l3-2.1Z" />
        ) : mark === "crest" ? (
          <path d="M12 2 4 5.5V12c0 5.2 3.4 9.6 8 11 4.6-1.4 8-5.8 8-11V5.5L12 2Zm-3.2 6h1.8v8h-1.8V8Zm4.6 0h1.8v8h-1.8V8Z" />
        ) : mark === "triangle" ? (
          <path d="M12 3 2.5 20.5h19L12 3Zm0 5.5 5.4 9.6H6.6L12 8.5Z" />
        ) : (
          <path d="M20 4c-9 0-15 4.5-15 11.5v3.2l-2.4 2.4 1.4 1.4 2.7-2.7h.3C13.5 19.8 20 14 20 4Zm-9.2 9.8c1.8-2.7 4.4-4.9 7.4-6-2 3.2-4.6 5.7-7.7 7.2l.3-1.2Z" />
        )}
      </svg>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-bold uppercase tracking-wide text-ink/80">
          {name}
        </span>
        {suffix ? (
          <span className="text-2xs uppercase tracking-wide opacity-70">
            {suffix}
          </span>
        ) : null}
      </span>
    </li>
  );
}
