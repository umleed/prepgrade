import type { Metadata } from "next";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Completing sign-in…",
};

// Clerk reads the OAuth callback query params at request time.
export const instant = false;

/**
 * Landing route for Clerk's OAuth (Google) redirect. `AuthenticateWithRedirectCallback`
 * finishes the handshake (exchanges the pending sign-in) and then sends the user
 * to the `redirectUrlComplete` we passed in (dashboard/onboarding).
 */
export default function SsoCallbackPage() {
  return <AuthenticateWithRedirectCallback />;
}
