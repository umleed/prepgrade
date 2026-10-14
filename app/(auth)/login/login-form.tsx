"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSignIn } from "@clerk/nextjs/legacy";
import { useClerk } from "@clerk/nextjs";
import { Alert, Button } from "@/components/ui";
import { EmailField } from "@/components/auth/email-field";
import { OtpField } from "@/components/auth/otp-field";
import { AuthDivider } from "@/components/auth/auth-divider";
import { GoogleButton } from "@/components/auth/google-button";
import { ArrowRightIcon } from "@/components/marketing/icons";
import { clerkErrorMessage } from "@/lib/auth/clerk-errors";
import type { AccessNotice } from "@/lib/auth/access";

/**
 * Sign-in form — Clerk email-code (one-time password) flow.
 *
 * Step 1 "identify": collect the email, ask Clerk to send a 6-digit code.
 * Step 2 "verify": collect the code, verify it, then activate the session and
 * route to `next` (default `/dashboard`). There is no password by design
 * (product decision: passwordless email code). The visual layout, copy, and
 * controls mirror the previous design exactly — only the password field is
 * replaced by the code step.
 */
export function LoginForm({
  next = "/dashboard",
  initialError,
  notice,
}: {
  next?: string;
  initialError?: string;
  /** Informational banner for an expired or ended session, set by our own redirect. */
  notice?: AccessNotice;
}) {
  const router = useRouter();
  const { signIn } = useSignIn();
  const { setActive } = useClerk();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"identify" | "verify">("identify");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const [resent, setResent] = useState(false);

  async function sendCode(targetEmail: string) {
    if (!signIn) {
      setError("Sign-in isn't ready yet. Please refresh and try again.");
      return;
    }
    // Start the sign-in for this identifier so Clerk resolves the factors.
    const created = await signIn.create({ identifier: targetEmail });
    const emailFactor = created.supportedFirstFactors?.find(
      (factor) => factor.strategy === "email_code",
    ) as { emailAddressId?: string } | undefined;
    if (!emailFactor?.emailAddressId) {
      throw new Error("Email-code sign-in isn't available for this account.");
    }
    // Send the one-time code to that address (throws on failure).
    await created.prepareFirstFactor({
      strategy: "email_code",
      emailAddressId: emailFactor.emailAddressId,
    });
  }

  async function handleIdentify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setResent(false);
    if (!email.trim()) {
      setError("Please enter your email address.");
      return;
    }
    setPending(true);
    try {
      await sendCode(email.trim());
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
      const result = await signIn?.attemptFirstFactor({
        strategy: "email_code",
        code,
      });
      if (result?.status === "complete" && result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.replace(next);
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
      await sendCode(email.trim());
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
            Check your inbox
          </h1>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            We sent a 6-digit code to{" "}
            <strong className="text-ink">{email}</strong>. Enter it below to
            sign in to PrepGrade.
          </p>
        </div>

        {error ? (
          <Alert variant="danger" title="Unable to verify">
            {error}
          </Alert>
        ) : notice ? (
          <Alert variant={notice.variant} title={notice.title} announce={false}>
            {notice.message}
          </Alert>
        ) : null}
        {resent && !error ? (
          <Alert variant="info" title="Code resent">
            A fresh code is on its way to {email}.
          </Alert>
        ) : null}

        <form onSubmit={handleVerify} className="flex flex-col gap-4" noValidate>
          <OtpField
            label="Verification code"
            value={code}
            onChange={(value) => setCode(value)}
            description="Codes expire shortly — request a new one if it's been a while."
            error={error && code.length === 0 ? error : undefined}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={pending}
          >
            {pending ? "Verifying…" : "Verify & sign in"}
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
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-ink">
          Welcome back
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-muted">
          Sign in to your PrepGrade account and continue building better
          learning outcomes.
        </p>
      </div>

      {error ? (
        <Alert variant="danger" title="Unable to sign in">
          {error}
        </Alert>
      ) : notice ? (
        <Alert variant={notice.variant} title={notice.title} announce={false}>
          {notice.message}
        </Alert>
      ) : null}

      <form onSubmit={handleIdentify} className="flex flex-col gap-4" noValidate>
        <EmailField
          label="Email address"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.edu.ng"
          autoComplete="email"
          required
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={pending}
        >
          {pending ? "Sending code…" : "Continue with email"}
          {pending ? null : <ArrowRightIcon className="h-4 w-4" />}
        </Button>
      </form>

      <AuthDivider label="Or continue with" />

      <GoogleButton next={next} onError={(message) => setError(message)} />

      <p className="text-center text-sm text-ink-muted">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-semibold text-brand hover:text-brand-hover"
        >
          Sign up
        </Link>
      </p>
    </div>
  );
}
