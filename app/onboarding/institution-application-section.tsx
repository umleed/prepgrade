import { InstitutionApplicationForm } from "@/app/onboarding/institution-application-form";
import type { ApplicantApplicationState } from "@/lib/data/institution-applications";
import {
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TONES,
  PROVISIONING_ERROR_LABELS,
  applicationDraftToFormValues,
  workspaceAccessReady,
} from "@/lib/institution-applications";
import { Alert, Badge, Button, Card } from "@/components/ui";

/**
 * The applicant's restricted onboarding dashboard — the institution-intent
 * branch of /onboarding, rendered server-side from the AUTHORITATIVE persisted
 * application record (never from Clerk signup metadata or client state).
 *
 * Status-dependent behaviour (0019 lifecycle):
 *   - no application          → the registration form.
 *   - draft                   → the form resumed with saved values; clearly
 *                               marked NOT SUBMITTED; save-draft stays available.
 *   - pending_review          → submitted confirmation + review checklist. A
 *                               duplicate submission is never offered (the
 *                               database refuses a second open application).
 *   - needs_information       → the reviewer's request + the secure response
 *                               form (answers re-queue the same row).
 *   - on_hold                 → the pause reason + what happens next.
 *   - approved                → access ONLY claimed when provisioning is
 *                               complete; a partial grant is shown as the
 *                               recoverable state it is, never as success.
 *   - rejected                → the decision + recorded reason + the way
 *                               forward (a fresh application), nothing deleted.
 *   - data source unavailable → an honest "not available" notice.
 */

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}

function StatusHeader({ state }: { state: ApplicantApplicationState }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-ink">
        Application for{" "}
        <span className="break-all">
          {state.values.institutionName || "your institution"}
        </span>
      </p>
      <Badge tone={APPLICATION_STATUS_TONES[state.status]} dot>
        {APPLICATION_STATUS_LABELS[state.status]}
      </Badge>
    </div>
  );
}

/** The shared verification checklist — honest about what review involves and
 *  that document upload does not exist on the platform yet. */
function ReviewChecklist() {
  return (
    <div className="rounded-card border border-border bg-surface-muted p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        What the review team checks
      </p>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink-muted">
        <li>• Your institution&apos;s identity, type, and location.</li>
        <li>• A reachable business contact (person, email, phone).</li>
        <li>• That the institution is real and eligible for a workspace.</li>
        <li>
          • Document upload is not available on PrepGrade yet — the team
          reviews the details you submit and may ask for more information.
        </li>
      </ul>
    </div>
  );
}

function SupportNote() {
  return (
    <p className="text-xs leading-5 text-ink-subtle">
      Need help? Reply to any request from the review team on this page —
      your responses arrive directly with the reviewers. Nothing here
      replaces a super admin&apos;s decision.
    </p>
  );
}

function Timeline({ state }: { state: ApplicantApplicationState }) {
  const events: Array<{ label: string; date: string }> = [
    {
      label: state.status === "draft" ? "Draft started" : "Submitted",
      date: state.createdAt,
    },
  ];
  if (state.respondedAt) {
    events.push({ label: "You responded", date: state.respondedAt });
  }
  if (state.decidedAt && state.status !== "pending_review") {
    events.push({
      label:
        state.status === "approved"
          ? "Approved"
          : state.status === "rejected"
            ? "Decided"
            : "Last reviewer update",
      date: state.decidedAt,
    });
  }
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-2xs text-ink-subtle">
      {events.map((event) => (
        <div key={event.label} className="flex items-center gap-1.5">
          <dt>{event.label}:</dt>
          <dd className="font-medium text-ink-muted">
            {formatDate(event.date)}
          </dd>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <dt>Last update:</dt>
        <dd className="font-medium text-ink-muted">
          {formatDate(state.updatedAt)}
        </dd>
      </div>
    </dl>
  );
}

export function InstitutionApplicationSection({
  defaultType,
  state,
  unavailable,
}: {
  defaultType: string;
  state: ApplicantApplicationState | null;
  unavailable: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            Institution registration
          </h2>
          <p className="mt-1 text-sm leading-6 text-ink-muted">
            A PrepGrade super admin reviews every registration before a
            workspace opens. This page always shows your real application
            status — it is read from the review record on every visit.
          </p>
        </div>

        {unavailable ? (
          <Alert variant="warning" title="Registration is temporarily unavailable">
            The applications service isn&apos;t reachable on this environment
            yet, so submissions are disabled. Your account is safe — please
            try again later.
          </Alert>
        ) : state === null ? (
          <InstitutionApplicationForm defaultType={defaultType} />
        ) : (
          <>
            <StatusHeader state={state} />
            <Timeline state={state} />

            {state.status === "draft" ? (
              <>
                <Alert variant="info" title="Not submitted yet">
                  This is a private draft — the review team cannot see it and
                  no clock is running. Complete the details below and choose
                  “Submit for review” when you are ready.
                </Alert>
                <InstitutionApplicationForm
                  defaultType={defaultType}
                  mode="draft"
                  applicationId={state.id}
                  initial={applicationDraftToFormValues(state.values)}
                />
              </>
            ) : state.status === "pending_review" ? (
              <>
                <p className="text-sm leading-6 text-ink-muted">
                  Your application was submitted successfully and is in the
                  review queue. You&apos;ll see the outcome here, and any
                  request for more information will appear on this page.
                </p>
                {state.applicantResponseNote ? (
                  <Alert variant="success" title="Your response was recorded">
                    The review team has your answer from{" "}
                    {formatDate(state.respondedAt ?? state.updatedAt)} and is
                    re-assessing your application.
                  </Alert>
                ) : null}
                <ReviewChecklist />
                <SupportNote />
              </>
            ) : state.status === "needs_information" ? (
              <>
                <Alert
                  variant="info"
                  title="The review team asked for more information"
                >
                  {state.infoRequestNote ??
                    "The reviewers need additional detail before they can decide."}
                </Alert>
                <InstitutionApplicationForm
                  defaultType={defaultType}
                  mode="response"
                  applicationId={state.id}
                  initial={applicationDraftToFormValues(state.values)}
                />
              </>
            ) : state.status === "on_hold" ? (
              <>
                <Alert variant="warning" title="Review paused">
                  {state.holdNote ??
                    "A super admin paused this review — this is not a rejection."}{" "}
                  The review team will resume it when the outstanding point is
                  resolved; you may add information any time by responding to
                  a request on this page.
                </Alert>
                <ReviewChecklist />
                <SupportNote />
              </>
            ) : state.status === "approved" ? (
              workspaceAccessReady(state.status, state.provisioningStatus) ? (
                <div className="flex flex-col gap-3">
                  <Alert variant="success" title="Approved — your workspace is ready">
                    {state.values.institutionName || "Your institution"} is
                    approved, and you are its first administrator. Open your
                    institution dashboard to continue setting it up.
                  </Alert>
                  <div>
                    <Button href="/institution" variant="primary" size="md">
                      Open institution dashboard
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Alert variant="success" title="Approved">
                    {state.values.institutionName || "Your institution"} has
                    been approved.
                  </Alert>
                  <Alert variant="warning" title="Workspace access is still being prepared">
                    {state.provisioningError
                      ? `${PROVISIONING_ERROR_LABELS[state.provisioningError]} `
                      : ""}
                    A platform super admin completes this step — it is
                    recoverable and does not undo your approval. Your
                    dashboard will open here as soon as access is provisioned.
                  </Alert>
                </>
              )
            ) : (
              <>
                <Alert variant="danger" title="Application rejected">
                  {state.rejectionReason ??
                    "The review team declined this application. The record below explains the decision."}
                </Alert>
                <p className="text-sm leading-6 text-ink-muted">
                  This decision applies to this application only — nothing was
                  deleted, and you may submit a fresh application with
                  corrected details. The original submission stays on file for
                  the review team.
                </p>
                <InstitutionApplicationForm
                  defaultType={defaultType}
                  initial={applicationDraftToFormValues(state.values)}
                />
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
