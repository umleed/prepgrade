"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  decideInstitutionApplicationAction,
  retryApplicationProvisioningAction,
} from "@/app/platform/institutions/pending-approvals/actions";
import type { ApplicationDetail } from "@/lib/data/institution-applications";
import { platformAuditActionLabel } from "@/lib/audit/platform";
import {
  APPLICATION_DECISION_LABELS,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TONES,
  PROVISIONING_ERROR_LABELS,
  PROVISIONING_STATUS_LABELS,
  PROVISIONING_STATUS_TONES,
  availableDecisions,
  decisionRequiresNote,
  formatApplicationLocation,
  institutionTypeLabel,
  type ApplicationDecision,
} from "@/lib/institution-applications";
import { Alert, Badge, Button, Dialog, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Application review side panel (pending-approvals).
 *
 * Server-rendered when the queue URL carries `?review=<id>`: the page has
 * already re-checked SUPER_ADMIN and loaded this ONE application's detail and
 * real decision history, so nothing here fetches data or trusts a client-supplied
 * id. This component is convenience, not protection — the authoritative
 * authorization + validation live in `decideInstitutionApplicationAction`.
 *
 * The actions offered are EXACTLY the transitions the pure policy allows from
 * the application's current status (approve/reject/request-information for an
 * open application, none for a decided one), so the UI can never present a move
 * the server would refuse. Reject and request-information require a written
 * reason; approve requires a confirmation. On success the queue route is
 * refreshed so the panel re-renders with the new status — it is never updated
 * optimistically here.
 *
 * DOCUMENTS: there is no file-storage backend in the product yet, so an
 * application carries no attachments and this panel says so truthfully rather
 * than inventing a documents section.
 */

export type DecisionHistoryItem = {
  id: number;
  action: string;
  outcome: "success" | "failed" | "denied";
  createdAt: string;
  summary: string | null;
};

const OUTCOME_TONE: Record<DecisionHistoryItem["outcome"], "success" | "warning" | "danger"> = {
  success: "success",
  failed: "warning",
  denied: "danger",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-subtle">
        {label}
      </dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

export function ApplicationReviewDrawer({
  application,
  decisionHistory,
  closeHref,
}: {
  application: ApplicationDetail;
  decisionHistory: DecisionHistoryItem[];
  closeHref: string;
}) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const [openDecision, setOpenDecision] = useState<ApplicationDecision | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const decisions = availableDecisions(application.status);
  const isDecided = decisions.length === 0;

  // Close on Escape (the panel is a modal surface).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (openDecision) {
          setOpenDecision(null);
        } else {
          router.push(closeHref);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openDecision, closeHref, router]);

  function beginDecision(decision: ApplicationDecision) {
    setMessage(null);
    setNotice(null);
    setNote("");
    setOpenDecision(decision);
  }

  async function submitDecision() {
    if (!openDecision || pending) return;
    setPending(true);
    setMessage(null);
    const result = await decideInstitutionApplicationAction(
      application.id,
      openDecision,
      note,
    );
    setPending(false);
    if (result.ok) {
      setOpenDecision(null);
      setNotice(
        result.warning ??
          (result.status === "approved" && result.provisioning === "provisioned"
            ? "Approved — the institution was created and the applicant's workspace access is ready."
            : `Decision recorded — the application is now “${APPLICATION_STATUS_LABELS[result.status]}”.`),
      );
      // Re-read server state; the panel re-renders with the new status and the
      // queue summary/table refresh. Never trust a locally-mutated status.
      router.refresh();
    } else {
      setMessage(result.message);
    }
  }

  // Secure recovery path for an approved application whose access grant only
  // partially completed. Server re-checks SUPER_ADMIN + the self-provisioning
  // guard and is idempotent; the panel never shows a locally-guessed state.
  async function retryProvisioning() {
    if (retrying) return;
    setRetrying(true);
    setMessage(null);
    setNotice(null);
    const result = await retryApplicationProvisioningAction(application.id);
    setRetrying(false);
    if (result.ok) {
      setNotice(
        result.provisioning === "provisioned"
          ? "Workspace access is ready — the applicant can now open their institution dashboard."
          : "Provisioning still could not complete. Review the reason and try again.",
      );
      router.refresh();
    } else {
      setMessage(result.message);
    }
  }

  const requiresNote = openDecision ? decisionRequiresNote(openDecision) : false;
  const noteBlocked = requiresNote && note.trim().length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-panel-title"
    >
      {/* Scrim — click to close (returns to the filtered queue). */}
      <Link
        href={closeHref}
        aria-label="Close review panel"
        className="absolute inset-0 bg-ink/40"
        tabIndex={-1}
      />

      <div
        ref={panelRef}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-surface shadow-raised"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-surface px-5 py-4">
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle">
              Application review
            </p>
            <h2
              id="review-panel-title"
              className="mt-0.5 truncate text-base font-semibold text-ink"
            >
              {application.institutionName}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={APPLICATION_STATUS_TONES[application.status]} dot>
              {APPLICATION_STATUS_LABELS[application.status]}
            </Badge>
            <Link href={closeHref} aria-label="Close review panel">
              <span className="inline-flex size-8 items-center justify-center rounded-field text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink">
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                  <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-6 px-5 py-5">
          {notice ? (
            <Alert variant={notice.startsWith("The decision was recorded, but") ? "warning" : "success"} title="Decision recorded">
              {notice}
            </Alert>
          ) : null}
          {message ? (
            <Alert variant="danger" title="Decision not applied">
              {message}
            </Alert>
          ) : null}

          {/* Institution details */}
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Institution</h3>
            <dl className="grid grid-cols-2 gap-3">
              <DetailRow label="Type" value={institutionTypeLabel(application.institutionType)} />
              <DetailRow
                label="Submitted"
                value={formatDate(application.submittedAt)}
              />
              <DetailRow
                label="Location"
                value={formatApplicationLocation({
                  city: application.city,
                  state: application.state,
                  country: application.country,
                })}
              />
              <DetailRow label="Address" value={application.address} />
            </dl>
            {application.description ? (
              <p className="rounded-field bg-surface-muted px-3 py-2 text-sm leading-6 text-ink-muted">
                {application.description}
              </p>
            ) : null}
          </section>

          {/* Applicant contact */}
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Applicant</h3>
            <dl className="grid grid-cols-2 gap-3">
              <DetailRow label="Contact person" value={application.contactPerson} />
              <DetailRow label="Phone" value={application.contactPhone} />
              <DetailRow label="Email" value={application.contactEmail} />
            </dl>
          </section>

          {/* Documents — honest empty state (no storage backend exists yet). */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-ink">Submitted documents</h3>
            <p className="rounded-field border border-dashed border-border-strong bg-canvas px-3 py-3 text-sm leading-6 text-ink-muted">
              No documents are attached to this application. Document upload is
              not yet available on PrepGrade, so reviewers assess the
              information above only.
            </p>
          </section>

          {/* Prior decision context */}
          {application.status === "rejected" && application.rejectionReason ? (
            <Alert variant="danger" title="Rejection reason">
              {application.rejectionReason}
            </Alert>
          ) : null}
          {application.holdNote ? (
            <Alert variant="warning" title="Why the review is on hold">
              {application.holdNote}
            </Alert>
          ) : null}
          {application.infoRequestNote ? (
            <Alert variant="info" title="Information requested from the applicant">
              {application.infoRequestNote}
            </Alert>
          ) : null}
          {application.applicantResponseNote ? (
            <Alert variant="success" title="Applicant responded">
              {application.applicantResponseNote}{' '}
              <span className="text-2xs text-ink-subtle">
                ({formatDate(application.respondedAt ?? application.updatedAt)})
              </span>
            </Alert>
          ) : null}

          {/* Decision controls */}
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Decision</h3>
            {isDecided ? (
              <p className="text-sm leading-6 text-ink-muted">
                This application has already been decided. No further actions are
                available.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {decisions.map((decision) => {
                  const variant =
                    decision === "approve"
                      ? "primary"
                      : decision === "reject"
                        ? "danger"
                        : "secondary";
                  return (
                    <Button
                      key={decision}
                      type="button"
                      size="sm"
                      variant={variant}
                      disabled={pending}
                      onClick={() => beginDecision(decision)}
                    >
                      {APPLICATION_DECISION_LABELS[decision]}
                    </Button>
                  );
                })}
              </div>
            )}
            <p className="text-2xs leading-4 text-ink-subtle">
              Approving creates the institution and grants the applicant&apos;s
              first-administrator workspace access. Every decision and every
              grant is confirmed and audit-logged.
            </p>
          </section>

          {/* Workspace access — the post-approval provisioning outcome. */}
          {application.status === "approved" ? (
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">Workspace access</h3>
                {application.provisioningStatus !== "provisioned" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={retrying}
                    onClick={retryProvisioning}
                  >
                    {retrying ? "Retrying…" : "Retry provisioning"}
                  </Button>
                ) : null}
              </div>
              <Badge tone={PROVISIONING_STATUS_TONES[application.provisioningStatus]} dot>
                {PROVISIONING_STATUS_LABELS[application.provisioningStatus]}
              </Badge>
              {application.provisioningStatus === "provisioned" ? (
                <p className="text-2xs leading-4 text-ink-muted">
                  The applicant is this institution&apos;s first administrator. They
                  reach the institution dashboard on their next page load.
                </p>
              ) : application.provisioningError ? (
                <Alert variant="warning" title="Provisioning needs attention">
                  {PROVISIONING_ERROR_LABELS[application.provisioningError]}
                </Alert>
              ) : (
                <p className="text-2xs leading-4 text-ink-muted">
                  Access has not been provisioned yet. Use “Retry provisioning”
                  to grant it.
                </p>
              )}
            </section>
          ) : null}

          {/* Decision history (real audit rows) */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-ink">Decision history</h3>
            {decisionHistory.length === 0 ? (
              <p className="text-sm leading-6 text-ink-muted">
                No decisions have been recorded for this application yet.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {decisionHistory.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    <Badge tone={OUTCOME_TONE[entry.outcome]}>{entry.outcome}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">
                        {platformAuditActionLabel(entry.action)}
                      </p>
                      {entry.summary ? (
                        <p className="text-2xs leading-4 text-ink-muted">{entry.summary}</p>
                      ) : null}
                    </div>
                    <time
                      dateTime={entry.createdAt}
                      className="shrink-0 text-2xs text-ink-subtle"
                    >
                      {formatDate(entry.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* Confirmation / note dialog for the chosen decision */}
      <Dialog
        open={openDecision !== null}
        onOpenChange={(next) => {
          if (!next && !pending) setOpenDecision(null);
        }}
        dismissable={!pending}
        title={
          openDecision === "approve"
            ? "Approve this institution?"
            : openDecision === "reject"
              ? "Reject this application?"
              : openDecision === "put_on_hold"
                ? "Put this review on hold?"
                : "Request more information?"
        }
        description={
          openDecision === "approve"
            ? `Approving creates the “${application.institutionName}” institution and grants the applicant access as its first administrator. This is recorded in the audit log.`
            : openDecision === "reject"
              ? "The applicant will see the reason you record here. This is final and audit-logged."
              : openDecision === "put_on_hold"
                ? "Holding PAUSES the review — it is not a rejection. The applicant sees that the review is paused, and you can still request information, approve, or reject from here."
                : "Tell the applicant what additional information is needed. This moves the application to “Needs information” and is visible to the applicant."
        }
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => setOpenDecision(null)}
            >
              Cancel
            </Button>
            <Button
              variant={openDecision === "reject" ? "danger" : "primary"}
              size="sm"
              disabled={pending || noteBlocked}
              onClick={submitDecision}
            >
              {pending
                ? "Working…"
                : openDecision === "approve"
                  ? "Approve institution"
                  : openDecision === "reject"
                    ? "Reject application"
                    : openDecision === "put_on_hold"
                      ? "Put on hold"
                      : "Send request"}
            </Button>
          </>
        }
      >
        {requiresNote ? (
          <Textarea
            label={
              openDecision === "reject"
                ? "Rejection reason"
                : openDecision === "put_on_hold"
                  ? "Hold reason"
                  : "Information requested"
            }
            required
            rows={4}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              openDecision === "reject"
                ? "Explain why the application is being rejected…"
                : openDecision === "put_on_hold"
                  ? "Explain what is pausing this review…"
                  : "Describe what additional information is needed…"
            }
          />
        ) : (
          <p className={cn("text-sm leading-6 text-ink-muted")}>
            This action cannot be undone from the queue. The decision and your
            reviewer identity are written to the platform audit log.
          </p>
        )}
      </Dialog>
    </div>
  );
}
