"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, Input, Select, Textarea } from "@/components/ui";
import {
  INSTITUTION_TYPES,
  INSTITUTION_TYPE_LABELS,
  validateInstitutionProfileUpdate,
  type InstitutionProfileField,
} from "@/lib/institutions";
import type { InstitutionProfile } from "@/lib/data/institution-profile";
import {
  updateInstitutionProfileAction,
  type ProfileActionResult,
} from "./actions";

type ProfileValues = Record<InstitutionProfileField, string>;

/** Turn the nullable stored profile into the all-strings shape the inputs bind. */
function toValues(profile: InstitutionProfile): ProfileValues {
  return {
    name: profile.name,
    type: profile.type ?? "",
    shortName: profile.shortName ?? "",
    description: profile.description ?? "",
    country: profile.country ?? "",
    state: profile.state ?? "",
    city: profile.city ?? "",
    address: profile.address ?? "",
    contactPerson: profile.contactPerson ?? "",
    contactEmail: profile.contactEmail ?? "",
    contactPhone: profile.contactPhone ?? "",
  };
}

/**
 * Institution Settings › General — the tenant's own identity & contact record.
 *
 * Every field maps to a real migration-0015 column on `institutions`; nothing
 * here is a decorative control. The form runs the SAME pure validator the
 * server action uses (`validateInstitutionProfileUpdate`) for instant feedback,
 * then calls the action, which re-validates and re-scopes to the trusted tenant
 * authoritatively (AGENTS.md §5, §6). Saving only ever writes the caller's own
 * row, and legacy `null` values stay blank (optional) rather than being
 * guessed — an admin can correct the name without being forced to fill fields
 * the schema does not require.
 */
export function InstitutionProfileForm({ initial }: { initial: InstitutionProfile }) {
  const router = useRouter();
  const [values, setValues] = useState<ProfileValues>(() => toValues(initial));
  const [errors, setErrors] = useState<Partial<Record<InstitutionProfileField, string>>>({});
  const [message, setMessage] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function setField(key: InstitutionProfileField, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (saved) setSaved(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Client-side gate for UX; the server action repeats this authoritatively.
    const clientResult = validateInstitutionProfileUpdate(values);
    if (!clientResult.ok) {
      setErrors(clientResult.errors);
      setSaved(false);
      return;
    }

    setErrors({});
    setMessage(undefined);
    setSubmitting(true);
    try {
      const result: ProfileActionResult = await updateInstitutionProfileAction(values);
      if (result.ok) {
        setSaved(true);
        // Reflect the new name in the shell/dashboard chrome without a reload.
        router.refresh();
      } else {
        setErrors(result.errors);
        setMessage(result.message);
      }
    } catch {
      setMessage("Something went wrong while saving. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {saved ? (
        <Alert variant="success" title="Settings saved">
          Your institution profile has been updated.
        </Alert>
      ) : null}
      {message ? (
        <Alert variant="danger" title="Couldn't save your changes">
          {message}
        </Alert>
      ) : null}

      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-ink">Identity</h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              Your institution&apos;s name and how it is described across the
              platform.
            </p>
          </div>
          <Input
            label="Institution name"
            name="name"
            autoComplete="off"
            value={values.name}
            onChange={(e) => setField("name", e.target.value)}
            error={errors.name}
            description="Shown in the sidebar, results, and the platform directory. Must be unique."
            required
          />
          <Select
            label="Institution type"
            name="type"
            required={false}
            value={values.type}
            onChange={(e) => setField("type", e.target.value)}
            error={errors.type}
            description="A coarse, non-personal descriptor. Leave unset if it does not apply."
          >
            <option value="">Not set</option>
            {INSTITUTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {INSTITUTION_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <Input
            label="Short name"
            name="shortName"
            autoComplete="off"
            required={false}
            value={values.shortName}
            onChange={(e) => setField("shortName", e.target.value)}
            error={errors.shortName}
            description="An optional abbreviation used in tight spaces."
          />
          <Textarea
            label="Description"
            name="description"
            required={false}
            rows={3}
            value={values.description}
            onChange={(e) => setField("description", e.target.value)}
            error={errors.description}
            placeholder="A sentence or two about your institution."
          />
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-ink">Location</h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              Where your institution operates. All fields are optional.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input
              label="Country"
              name="country"
              autoComplete="off"
              required={false}
              value={values.country}
              onChange={(e) => setField("country", e.target.value)}
              error={errors.country}
            />
            <Input
              label="State"
              name="state"
              autoComplete="off"
              required={false}
              value={values.state}
              onChange={(e) => setField("state", e.target.value)}
              error={errors.state}
            />
            <Input
              label="City"
              name="city"
              autoComplete="off"
              required={false}
              value={values.city}
              onChange={(e) => setField("city", e.target.value)}
              error={errors.city}
            />
          </div>
          <Textarea
            label="Full address"
            name="address"
            required={false}
            rows={2}
            value={values.address}
            onChange={(e) => setField("address", e.target.value)}
            error={errors.address}
          />
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="text-base font-semibold text-ink">Contact</h2>
            <p className="mt-0.5 text-sm text-ink-muted">
              The person and channels the platform team can reach. Saving here
              records contact details only — no email or call is sent by this
              page.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Contact person"
              name="contactPerson"
              autoComplete="off"
              required={false}
              value={values.contactPerson}
              onChange={(e) => setField("contactPerson", e.target.value)}
              error={errors.contactPerson}
            />
            <Input
              label="Contact email"
              name="contactEmail"
              type="email"
              autoComplete="off"
              required={false}
              value={values.contactEmail}
              onChange={(e) => setField("contactEmail", e.target.value)}
              error={errors.contactEmail}
            />
          </div>
          <Input
            label="Contact phone"
            name="contactPhone"
            type="tel"
            autoComplete="off"
            required={false}
            value={values.contactPhone}
            onChange={(e) => setField("contactPhone", e.target.value)}
            error={errors.contactPhone}
            description="Include country code, e.g. +234 803 123 4567."
          />
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </Button>
        <p className="text-xs text-ink-subtle">
          Changes apply to your institution&apos;s profile only.
        </p>
      </div>
    </form>
  );
}
