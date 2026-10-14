import { LogoMark } from "./icons";

const footerSections = [
  {
    heading: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "How it works", href: "/#workflow" },
      { label: "Pricing", href: "/pricing" },
      { label: "Request a demo", href: "/demo-request" },
    ],
  },
  {
    heading: "For you",
    links: [
      { label: "For Schools", href: "/#for-schools" },
      { label: "For Teachers", href: "/#for-teachers" },
      { label: "For Students", href: "/#for-students" },
    ],
  },
  {
    heading: "Account",
    links: [
      { label: "Log in", href: "/login" },
      { label: "Get started", href: "/register" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.5fr_repeat(3,1fr)]">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-ink">
              <LogoMark className="h-8 w-8" />
              PrepGrade
            </div>
            <p className="max-w-xs text-sm leading-6 text-ink-muted">
              An assessment and examination intelligence platform for schools,
              teachers, and students in Nigeria — built for CBT, automatic
              grading, and actionable insight.
            </p>
          </div>

          {footerSections.map((section) => (
            <nav key={section.heading} aria-label={section.heading}>
              <h2 className="text-sm font-semibold text-ink">
                {section.heading}
              </h2>
              <ul className="mt-3 space-y-2">
                {section.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="text-sm text-ink-muted transition-colors hover:text-ink"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-border pt-6 text-sm text-ink-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; PrepGrade. All rights reserved.</p>
          <p>
            Built for JAMB, WAEC, and NECO preparation where content is legally
            usable.
          </p>
        </div>
      </div>
    </footer>
  );
}
