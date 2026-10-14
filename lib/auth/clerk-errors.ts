/**
 * Map Clerk auth errors to safe, user-facing messages. Clerk throws
 * `ClientAuthError` / `SignUpContinuationError` objects with an `errors[]`
 * array; we surface the code-specific message and never leak internals. Where a
 * message could reveal account existence we keep it intentionally generic.
 */

type ClerkLikeError =
  | {
      errors?: Array<{
        code?: string;
        message?: string;
        longMessage?: string;
      }>;
      message?: string;
    }
  | null
  | undefined;

export function clerkErrorMessage(
  error: ClerkLikeError,
  fallback = "Something went wrong. Please try again.",
): string {
  const first = error?.errors?.[0];
  const code = first?.code ?? "";
  const raw = (first?.longMessage ?? first?.message ?? error?.message ?? "").trim();

  switch (code) {
    case "invalid_code":
    case "form_invalid_code":
    case "verification_failed":
      return "That code is incorrect. Please check your inbox and try again.";
    case "expired_code":
    case "expired_verification_code":
    case "expired_last_second":
      return "That code has expired. Request a new one to continue.";
    case "identifier_not_found":
    case "user_not_found":
    case "not_found":
      return "We couldn't find an account for that email. Try signing up instead.";
    case "external_oauth_account_not_found":
      return "That social account isn't linked to an existing user yet. Try signing up.";
    case "identifier_already_signed_in":
      return "You're already signed in.";
    case "form_identifier_exists":
    case "user_already_exists":
      return "An account with this email already exists. Try signing in instead.";
    case "too_many_requests":
    case "too_many_verification_attempts":
    case "too_many_code_attempts":
      return "Too many attempts. Please wait a moment and try again.";
    case "invalid_email_address":
    case "form_email_invalid":
      return "Please enter a valid email address.";
    case "untrusted":
    case "external_verification_not_found":
      return "We couldn't verify that code. Please request a new one.";
    default:
      return raw || fallback;
  }
}
