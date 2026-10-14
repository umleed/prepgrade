"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSignUp } from "@clerk/nextjs/legacy";
import { useClerk } from "@clerk/nextjs";
import { Alert, Button, Input } from "@/components/ui";
import { EmailField } from "@/components/auth/email-field";
import { OtpField } from "@/components/auth/otp-field";
import { AuthDivider } from "@/components/auth/auth-divider";
import { GoogleButton } from "@/components/auth/google-button";
import { RegistrationIntentPicker } from "@/components/auth/registration-intent-picker";
import { ArrowRightIcon } from "@/components/marketing/icons";
import { clerkErrorMessage } from "@/lib/auth/clerk-errors";
import {
  REGISTRATION_INTENT_METADATA_KEY,
  normalizeRegistrationIntent,
  type RegistrationIntent,
} from "@/lib/auth/registration";

/**
 * Sign-up form — Clerk email-code (one-time password) flow.
 *
 * Step 1 "identify": pick an account type, collect name + email, create the
 * sign-up (Clerk sends a 6-digit code). Step 2 "verify": confirm the code,
 * activate the session, and route to `/onboarding` for first-time setup. There
 * is no password by design.
 *
 * SECURITY: the account type is stored as an UNTRUSTED registration intent on
 * Clerk's `unsafeMetadata` — the only metadata channel the browser SDK is
 * allowed to write. It is deliberately NOT used for authorization anywhere
 * (see `lib/auth/registration.ts` and `lib/auth/principal.ts`); it is a
 * starting point for onboarding copy, nothing more. Privileged roles
 * (`SUPER_ADMIN`, `INSTITUTION_ADMIN`) are not offered as options and would be
 * rejected by `normalizeRegistrationIntent()` even if a hostile client wrote
 * them into `unsafeMetadata` via devtools.
 */
export function RegisterForm() {
  const router = useRouter();
  const { signUp } = useSignUp();
  const { setActive } = useClerk();

  const [intent, setIntent] = useState<RegistrationIntent | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"identify" | "verify">("identify");
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [intentError, setIntentError] = useState<string | undefined>();

  async function handleIdentify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setIntentError(undefined);
    if (!signUp) {
      setError("Sign-up isn't ready yet. Please refresh and try again.");
      return;
    }
    // Re-check the intent on the client. The picker itself cannot produce a
    // privileged value; this guard rejects any state drift and mirrors what
    // `normalizeRegistrationIntent` will do again on the server read.
    const trustedIntent = normalizeRegistrationIntent(intent);
    if (!trustedIntent) {
      setIntentError("Choose the option that best describes you.");
      return;
    }
    if (!email.trim()) {
      setError("Please enter your email address.");
      return;
    }

    const [first, ...rest] = fullName.trim().split(/\s+/);
    setPending(true);
    try {
      // 1) Create the sign-up attempt with the collected name + email and the
      //    untrusted intent on `unsafeMetadata`. Clerk copies `unsafeMetadata`
      //    onto the user record when the sign-up completes, so `/onboarding`
      //    can pick up where the user left off. Nothing here grants access.
      await signUp.create({
        emailAddress: email.trim(),
        firstName: first || undefined,
        lastName: rest.join(" ") || undefined,
        unsafeMetadata: { [REGISTRATION_INTENT_METADATA_KEY]: trustedIntent },
      });
      // 2) Ask Clerk to email the 6-digit code. `create` alone does NOT send
      //    anything — this prepares the email_code verification and dispatches
      //    the message, mirroring signIn.prepareFirstFactor on the login side.
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setStep("verify");
    } catch (err) {
      setError(clerkErrorMessage(err as Parameters<typeof clerkErrorMessage>[0]));
    } finally {
      setPending(false);
    }
  }

  async function handleVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (code.length < 6) {
      setError("Enter the 6-digit code from your inbox.");
      return;
    }
    setPending(true);
    try {
      const result = await signUp?.attemptEmailAddressVerification({ code });
      if (result?.status === "complete" && result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.replace("/onboarding");
        router.refresh();
        return;
      }
      setError("We couldn't verify that code yet. Please try again.");
    } catch (err) {
      setError(clerkErrorMessage(err as Parameters<typeof clerkErrorMessage>[0]));
    } finally {
      setPending(false);
    }
  }

  async function handleResend() {
    setError(undefined);
    setResent(false);
    try {
      // Re-dispatch the 6-digit code to the same email address.
      await signUp?.prepareEmailAddressVerification({ strategy: "email_code" });
      setResent(true);
    } catch (err) {
      setError(clerkErrorMessage(err as Parameters<typeof clerkErrorMessage>[0]));
    }
  }

  if (step === "verify") {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">
            Confirm your email
          </h1>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            We sent a 6-digit code to{" "}
            <strong className="text-ink">{email}</strong>. Enter it below to
            activate your PrepGrade account.
          </p>
        </div>

        {error ? (
          <Alert variant="danger" title="Unable to verify">
            {error}
          </Alert>
        ) : null}

        <form onSubmit={handleVerify} className="flex flex-col gap-4" noValidate>
          <OtpField
            label="Verification code"
            value={code}
            onChange={(value) => setCode(value)}
            description="Codes expire shortly — go back and resend if it's been a while."
            error={error && code.length === 0 ? error : undefined}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={pending}
          >
            {pending ? "Verifying…" : "Verify & create account"}
            {pending ? null : <ArrowRightIcon className="h-4 w-4" />}
          </Button>
        </form>

        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => {
              setStep("identify");
              setCode("");
              setError(undefined);
              setResent(false);
            }}
            className="font-medium text-ink-muted transition-colors hover:text-ink"
          >
            ← Change email
          </button>
          <button
            type="button"
            onClick={handleResend}
            className="font-medium text-brand hover:text-brand-hover"
          >
            Resend code
          </button>
        </div>

        {resent ? (
          <Alert variant="success" title="Code sent">
            A new code is on its way to {email}. It may take a few seconds to
            arrive.
          </Alert>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-ink">
          Create your account
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-muted">
          Start building better assessments with PrepGrade. Choosing an account
          type only tells us which setup to show you next — it doesn&apos;t
          grant any workspace access on its own.
        </p>
      </div>

      {error ? (
        <Alert variant="danger" title="Unable to create account">
          {error}
        </Alert>
      ) : null}

      <form onSubmit={handleIdentify} className="flex flex-col gap-4" noValidate>
        <RegistrationIntentPicker
          value={intent}
          onChange={(value) => {
            setIntent(value);
            setIntentError(undefined);
          }}
          error={intentError}
          disabled={pending}
        />
        <Input
          label="Full name"
          name="full_name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Amina Yusuf"
          autoComplete="name"
          required
        />
        <EmailField
          label="Email address"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.edu.ng"
          required
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={pending}
        >
          {pending ? "Sending code…" : "Create account"}
        </Button>
      </form>

      <AuthDivider label="Or continue with" />

      <GoogleButton next="/onboarding" onError={(message) => setError(message)} />

      <p className="text-center text-sm text-ink-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-brand hover:text-brand-hover">
          Sign in
        </Link>
      </p>
    </div>
  );
}
