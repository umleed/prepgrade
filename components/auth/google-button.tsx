"use client";

import { useState } from "react";
import { useSignIn } from "@clerk/nextjs/legacy";
import { Button } from "@/components/ui";
import { GoogleIcon } from "./google-icon";
import { clerkErrorMessage } from "@/lib/auth/clerk-errors";

/**
 * "Continue with Google" button backed by Clerk's `oauth_google` strategy.
 * Kicks off Clerk's OAuth redirect and returns through `/sso-callback`, which
 * finalizes the session and completes to `next`. Google only (per product
 * decision); Microsoft/Apple are not enabled. Requires the Google provider to be
 * enabled in the Clerk Dashboard.
 */
export function GoogleButton({
  next = "/dashboard",
  onError,
}: {
  next?: string;
  onError?: (message: string) => void;
}) {
  const { signIn } = useSignIn();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    if (!signIn) {
      onError?.("Sign-in isn't ready yet. Please try again.");
      return;
    }
    setPending(true);
    try {
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: next,
      });
      // On success Clerk performs a full-page redirect to Google.
    } catch (error) {
      onError?.(clerkErrorMessage(error as Parameters<typeof clerkErrorMessage>[0]));
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="lg"
      className="w-full"
      onClick={handleClick}
      disabled={pending}
    >
      <GoogleIcon />
      {pending ? "Redirecting…" : "Continue with Google"}
    </Button>
  );
}
