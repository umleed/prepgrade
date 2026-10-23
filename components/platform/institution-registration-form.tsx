"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  createInstitutionAction,
  type InstitutionRegistrationState,
} from "@/app/platform/institutions/actions";
import {
  INSTITUTION_REGISTRATION_LIMITS,
  INSTITUTION_TYPES,
  INSTITUTION_TYPE_LABELS,
  type InstitutionRegistrationField,
} from "@/lib/institutions";
import {
  Alert,
  Button,
  Card,
  Input,
  Select,
  Textarea,
} from "@/components/ui";

/**
 * Platform "Add Institution" registration form (SUPER_ADMIN only — the page
 * and the server action both enforce this; the UI is convenience, not
 * protection, AGENTS.md §5).
 *
 * Follows the approved "Add New Institution" design's two implemented
 * sections (Basic Information, Location & Contact Details). The design's
 * Subscription Plan, logo upload, draft saving, and welcome-email toggle are
 * deliberately NOT rendered as working controls — those systems do not exist
 * yet, so they appear as honest notes instead of dead inputs. Client-side
 * `required`/`maxLength` are UX affordances only; the authoritative
 * validation, duplicate prevention, authorization, and audit all happen in
 * the server action.
 *
 * A rejected submission re-renders with every entered value preserved (the
 * action returns them), so an operator never retypes a long form because one
 * field was wrong. Success replaces the form with a confirmation panel and
 * links to the new tenant — no client-side navigation guesswork.
 */
export function InstitutionRegistrationForm() {
  const [state, formAction, isPending] = useActionState<
    InstitutionRegistrationState,
    FormData
  >(createInstitutionAction, null);

  const value = (field: InstitutionRegistrationField): string =>
    state?.values?.[field] ?? "";
  const error = (field: InstitutionRegistrationField): string | undefined =>
    state?.errors?.[field];

  if (state?.created) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success" title="Institution created">
          “{state.created.name}” is now registered and active on the platform.
          {state.warning ? ` ${state.warning}` : ""}
        </Alert>
        <Card>
          <div className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink-muted">
              Open the new tenant to review its record, set its status, or
              find it later in the directory.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href={`/platform/institutions/${state.created.id}`}>
                <Button type="button" size="md">
                  View institution
                </Button>
              </Link>
              <Link href="/platform/institutions">
                <Button type="button" variant="secondary" size="md">
                  Back to directory
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state?.message ? (
        <Alert variant="danger" title="Institution not created">
          {state.message}
        </Alert>
      ) : null}

      {/* --- 1. Basic Information -------------------------------------- */}
      <Card>
        <div className="flex flex-col gap-5 p-6">
          <SectionHeading
            step={1}
            title="Basic Information"
            description="Provide the main details about the institution."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Institution Name"
              name="name"
              required
              maxLength={INSTITUTION_REGISTRATION_LIMITS.name}
              placeholder="e.g. Al-Furqan Secondary School"
              autoComplete="off"
              defaultValue={value("name")}
              error={error("name")}
            />
            <Select
              label="Institution Type"
              name="type"
              required
              placeholder="Select institution type"
              defaultValue={value("type")}
              error={error("type")}
            >
              {INSTITUTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {INSTITUTION_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
            <Input
              label="Short Name"
              name="shortName"
              required={false}
              maxLength={INSTITUTION_REGISTRATION_LIMITS.shortName}
              placeholder="e.g. AFSS"
              autoComplete="off"
              defaultValue={value("shortName")}
              error={error("shortName")}
            />
            <div
              aria-hidden="true"
              className="flex flex-col items-center justify-center gap-1 rounded-field border border-dashed border-border-strong bg-surface-muted/60 px-4 py-6 text-center sm:justify-end"
            >
              <p className="text-sm font-medium text-ink-muted">Logo upload</p>
              <p className="text-xs text-ink-subtle">
                Not yet available — there is no verified secure storage flow to
                upload through, so no logo is collected.
              </p>
            </div>
          </div>
          <Textarea
            label="Description"
            name="description"
            required={false}
            rows={3}
            maxLength={INSTITUTION_REGISTRATION_LIMITS.description}
            placeholder="Briefly describe the institution..."
            defaultValue={value("description")}
            error={error("description")}
          />
        </div>
      </Card>

      {/* --- 2. Location & Contact Details ------------------------------ */}
      <Card>
        <div className="flex flex-col gap-5 p-6">
          <SectionHeading
            step={2}
            title="Location & Contact Details"
            description="Where the institution is located and how to reach them."
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Country"
              name="country"
              required
              maxLength={INSTITUTION_REGISTRATION_LIMITS.country}
              placeholder="e.g. Nigeria"
              autoComplete="off"
              defaultValue={value("country")}
              error={error("country")}
            />
            <Input
              label="State"
              name="state"
              required
              maxLength={INSTITUTION_REGISTRATION_LIMITS.state}
              placeholder="e.g. Borno"
              autoComplete="off"
              defaultValue={value("state")}
              error={error("state")}
            />
            <Input
              label="City"
              name="city"
              required
              maxLength={INSTITUTION_REGISTRATION_LIMITS.city}
              placeholder="e.g. Maiduguri"
              autoComplete="off"
              defaultValue={value("city")}
              error={error("city")}
            />
          </div>
          <Input
            label="Full Address"
            name="address"
            required
            maxLength={INSTITUTION_REGISTRATION_LIMITS.address}
            placeholder="e.g. No. 12, Maiduguri Road, Borno State"
            autoComplete="off"
            defaultValue={value("address")}
            error={error("address")}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Contact Person"
              name="contactPerson"
              required
              maxLength={INSTITUTION_REGISTRATION_LIMITS.contactPerson}
              placeholder="e.g. Ahmad Sani"
              autoComplete="off"
              defaultValue={value("contactPerson")}
              error={error("contactPerson")}
            />
            <Input
              label="Contact Email"
              name="contactEmail"
              type="email"
              required
              maxLength={INSTITUTION_REGISTRATION_LIMITS.contactEmail}
              placeholder="e.g. admin@school.edu.ng"
              autoComplete="off"
              defaultValue={value("contactEmail")}
              error={error("contactEmail")}
            />
            <Input
              label="Contact Phone"
              name="contactPhone"
              type="tel"
              required
              // Generous raw cap: spaces/dashes count here, but the server
              // normalises before applying the stored-value bound.
              maxLength={24}
              placeholder="e.g. +234 803 123 4567"
              autoComplete="off"
              defaultValue={value("contactPhone")}
              error={error("contactPhone")}
              description="Digits with an optional country code; spaces and dashes are fine."
            />
          </div>
        </div>
      </Card>

      {/* --- 3. What this flow does NOT do (honest deferrals) ----------- */}
      <Card>
        <div className="flex flex-col gap-5 p-6">
          <SectionHeading
            step={3}
            title="Plan & Onboarding Notes"
            description="Steps from the design that depend on systems not yet built."
          />
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-6 text-ink-muted">
            <li>
              <strong className="font-medium text-ink">Subscription plan</strong>{" "}
              — plans and entitlements are not implemented, so no plan is
              selected or enforced here.
            </li>
            <li>
              <strong className="font-medium text-ink">Initial status</strong>{" "}
              — a platform-registered institution starts as{" "}
              <strong className="font-medium text-ink">Active</strong> (the
              operator registering it is the trusted approver). Status can be
              changed later from the institution detail page. There is no
              draft state, so nothing is saved until you press Create.
            </li>
            <li>
              <strong className="font-medium text-ink">No emails are sent</strong>{" "}
              — the contact details are recorded for support, but no welcome
              or invitation email goes out from this form. The first
              administrator account will be provisioned through a separate
              trusted invitation workflow when it ships.
            </li>
          </ul>
        </div>
      </Card>

      {/* --- Actions ----------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-subtle">
          Every registration is recorded in the platform audit log.
        </p>
        <div className="flex gap-2">
          <Link href="/platform/institutions">
            <Button type="button" variant="ghost" size="md" disabled={isPending}>
              Cancel
            </Button>
          </Link>
          <Button type="submit" size="md" disabled={isPending}>
            {isPending ? "Creating…" : "Create Institution"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Numbered section heading matching the approved design's step markers. */
function SectionHeading({
  step,
  title,
  description,
}: {
  step: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white"
      >
        {step}
      </span>
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="text-sm text-ink-muted">{description}</p>
      </div>
    </div>
  );
}
