import Link from "next/link";
import Image from "next/image";
import { LogoMark } from "@/components/marketing/icons";

/**
 * Split-screen shell for every authentication screen (login, register,
 * password reset, verification). The left column holds the form; the right
 * column shows the approved marketing hero artwork from the design reference
 * (Assets/Screen_05_Login_Sign_In.png) and is decorative — hidden on small
 * screens so the form stays the focus on mobile.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Form column */}
      <div className="flex min-h-screen flex-col bg-surface px-6 py-8 sm:px-10 lg:min-h-0">
        <header className="flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-xl font-bold tracking-tight text-ink"
          >
            <LogoMark />
            PrepGrade
          </Link>
          <Link
            href="/"
            className="text-sm font-medium text-ink-muted transition-colors hover:text-ink"
          >
            ← Back to site
          </Link>
        </header>

        <main className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>

      {/* Decorative hero artwork (design reference). Trust metrics baked into
          this image are PLACEHOLDER and must be replaced with verified figures
          before public launch (see AGENTS.md §8 / marketing honesty policy). */}
      <aside
        aria-hidden="true"
        className="relative hidden bg-ink lg:block"
      >
        <Image
          src="/images/login-hero.png"
          alt=""
          fill
          priority
          sizes="(min-width: 1024px) 50vw, 0px"
          className="object-cover"
        />
      </aside>
    </div>
  );
}
