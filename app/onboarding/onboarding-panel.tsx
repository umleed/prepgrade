"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { Alert, Button, Card } from "@/components/ui";
import { RegistrationIntentPicker } from "@/components/auth/registration-intent-picker";
import { ArrowRightIcon } from "@/components/marketing/icons";
import {
  INTENT_LABELS,
  REGISTRATION_INTENT_METADATA_KEY,
  intentNextStep,
  normalizeRegistrationIntent,
  type RegistrationIntent,
} from "@/lib/auth/registration";

/**
 * Onboarding panel — the intent-aware part of `/onboarding`.
 *
 * Responsibilities:
 *   1. When no intent has been chosen yet (e.g. a Google OAuth sign-up, or a
 *      value that failed to normalise), present the four-option picker.
 *   2. Once an intent exists, render what happens next for that intent and
 *      offer a way to change it.
 *
 * Trust: the panel writes to Clerk's `unsafeMetadata` (browser-writable) with
 * `user.updateMetadata({ unsafeMetadata })`. That is safe *only because* the
 * value is untrusted by design — see `lib/auth/registration.ts`. It never
 * grants a role or a membership, and it is deliberately invisible to the
 * authorization stack (`principal.ts`, `access.ts`, `guards.ts`).
 *
 * Prompt 08 integration: real invitations, join codes, and super-admin
 * approvals will read the intent from `profiles.account_type` and provision
 * memberships server-side. This panel keeps the intent in Clerk today so the
 * UX is complete on its own, and nothing here needs to change when the swap
 * happens.
 */
export function OnboardingPanel({
  initialIntent,
}: {
  initialIntent: RegistrationIntent | null;
}) {
  const router = useRouter();
  const { user } = useUser();

  // Server-resolved intent drives the current state. A hostile value on
  // `unsafeMetadata` normalises to `null` in the reader, so we start in the
  // picker branch — never on a stale "approved" screen.
  const [intent, setIntent] = useState<RegistrationIntent | null>(initialIntent);
  const [editing, setEditing] = useState(initialIntent === null);
  const [draft, setDraft] = useState<RegistrationIntent | null>(initialIntent);
  const [draftError, setDraftError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function saveIntent() {
    setError(undefined);
    setDraftError(undefined);
    // Re-run the normaliser on the way out. The picker never produces a
    // privileged value, but this is defence in depth and mirrors the server
    // read path exactly.
    const trusted = normalizeRegistrationIntent(draft);
    if (!trusted) {
      setDraftError("Choose the option that best describes you.");
      return;
    }
    if (!user) {
      setError("Your session isn't ready yet. Please refresh and try again.");
      return;
    }

    setPending(true);
    try {
      // Deep-merge write: only our key is touched. Anything else the user
      // already has on `unsafeMetadata` is preserved.
      await user.updateMetadata({
        unsafeMetadata: { [REGISTRATION_INTENT_METADATA_KEY]: trusted },
      });
      setIntent(trusted);
      setEditing(false);
      router.refresh();
    } catch {
      setError("We couldn't save that choice. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function startEditing() {
    setDraft(intent);
    setDraftError(undefined);
    setError(undefined);
    setEditing(true);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-4">
        <RegistrationIntentPicker
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setDraftError(undefined);
          }}
          error={draftError}
          disabled={pending}
          description="This only decides which setup steps to show you next. No workspace unlocks until your institution or the PrepGrade team approves your account."
        />

        {error ? (
          <Alert variant="danger" title="Couldn't save your choice">
            {error}
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={saveIntent}
            disabled={pending}
          >
            {pending ? "Saving…" : "Save & continue"}
            {pending ? null : <ArrowRightIcon className="h-4 w-4" />}
          </Button>
          {intent ? (
            <Button type="button" variant="secondary" size="md" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  // `intent` is guaranteed non-null here — the picker branch is rendered
  // otherwise. Narrow defensively so the copy below can trust it.
  if (!intent) return null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Account type on file
          </p>
          <p className="mt-1 text-lg font-semibold text-ink">
            {INTENT_LABELS[intent]}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={startEditing}>
          Change
        </Button>
      </div>

      <Alert variant="info" title="What happens next" announce={false}>
        {intentNextStep(intent)}
      </Alert>

      <IntentBranchCopy intent={intent} />

      <div className="flex flex-wrap gap-3">
        <Link href="/dashboard">
          <Button type="button" variant="primary" size="md">
            Go to dashboard
            <ArrowRightIcon className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}

/**
 * The intent-specific setup card. Wording is deliberately honest: nothing here
 * claims that a workspace is unlocked or that an approval has been granted.
 * Prompt 08 replaces the "pending" copy with real status once invitations and
 * institution registrations exist.
 */
function IntentBranchCopy({ intent }: { intent: RegistrationIntent }) {
  if (intent === "student" || intent === "teacher") {
    return (
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 p-5 sm:p-6">
          <h2 className="text-sm font-semibold text-ink">
            {intent === "student"
              ? "Join your school or CBT centre"
              : "Get invited by an institution"}
          </h2>
          <p className="text-sm leading-6 text-ink-muted">
            {intent === "student"
              ? "PrepGrade accounts for students are created by their institution. Ask your school or CBT centre admin for an invitation — you'll appear in their roster and pick up your exams automatically."
              : "PrepGrade accounts for teachers are created by their institution. Ask your school or CBT centre admin for an invitation, or send them the demo-request below so they can onboard."}
          </p>
          <p className="text-xs text-ink-muted">
            Invitation and join-code handling ships with the tenant schema
            (prompt 08). Until then, your dashboard will show a clear &ldquo;no
            workspace yet&rdquo; state — nothing is hidden or half-built.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Link href="/demo-request">
              <Button type="button" variant="secondary" size="sm">
                Send PrepGrade a demo request
              </Button>
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  // Institution registration intents (cbt_centre / school).
  const label = intent === "school" ? "school" : "CBT centre";
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-ink">
          Register your {label}
        </h2>
        <p className="text-sm leading-6 text-ink-muted">
          Institution workspaces open after a PrepGrade super admin reviews the
          registration. Choosing this option only records your intent — it does
          not create an institution, an admin membership, or any data on your
          account.
        </p>
        <p className="text-sm leading-6 text-ink-muted">
          Use the demo-request form to submit your {label}&apos;s details. The
          PrepGrade team will follow up and provision your institution once the
          registration is approved.
        </p>
        <p className="text-xs text-ink-muted">
          In-app pending-registration status ships with the tenant schema
          (prompt 08) and the super-admin review queue (prompt 31).
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/demo-request">
            <Button type="button" variant="primary" size="sm">
              Start {label} registration
              <ArrowRightIcon className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}
