import type { Metadata } from "next";
import { LoginForm } from "./login-form";
import { loginNoticeFromReason } from "@/lib/auth/access";
import { safeInternalRedirect } from "@/lib/auth/redirect";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your PrepGrade account.",
};

// Reads `searchParams` at request time (redirect target + callback errors), so
// this route is intentionally not prerendered (Cache Components).
export const instant = false;

/** Generic messages for callback-driven error codes (no internals leaked). */
const ERROR_MESSAGES: Record<string, string> = {
  auth_callback:
    "We couldn't complete sign-in with that provider. Please try again.",
  invalid_or_expired_link:
    "That link is invalid or has expired. Please sign in again or request a new link.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeInternalRedirect(
    typeof params.next === "string" ? params.next : undefined,
  );
  const errorCode = typeof params.error === "string" ? params.error : undefined;
  const initialError = errorCode ? ERROR_MESSAGES[errorCode] : undefined;
  // Session notices are only shown for `reason` values our own guards write
  // (`expired`, `signed-out`); anything else is ignored, so a crafted query
  // param can't dictate what the page claims happened.
  const notice = loginNoticeFromReason(
    typeof params.reason === "string" ? params.reason : undefined,
  );

  return (
    <LoginForm
      next={next}
      initialError={initialError}
      notice={notice ?? undefined}
    />
  );
}
