"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  respondToInformationRequestAction,
  saveApplicationDraftAction,
  submitInstitutionApplicationAction,
  type DraftSaveResult,
  type RespondApplicationResult,
  type SubmitApplicationResult,
} from "@/app/onboarding/actions";
import {
  INSTITUTION_TYPES,
  institutionTypeLabel,
  type ApplicationResponseField,
  type ApplicationSubmissionField,
} from "@/lib/institution-applications";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui";

/**
 * The applicant's institution registration form. It collects the same business
 * details the platform registration uses and submits them as an APPLICATION
 * (pending review) — it does not create a workspace. Field validation is
 * mirrored server-side in the action; these client checks are for fast,
 * accessible feedback only (AGENTS.md §5 — the browser is never the gate).
 *
 * Three modes, all writing through session-gated server actions:
 *   - "new"      → a brand-new application (submit creates the row),
 *   - "draft"    → a saved draft (prefilled; "Save draft" + "Submit"),
 *   - "response" → answering a needs_information request (prefilled + a
 *                  required response note; submitting re-queues the row).
 */
type FieldValues = Record<ApplicationSubmissionField, string>;

const EMPTY: FieldValues = {
  institutionName: "",
  institutionType: "",
  contactPerson: "",
  contactEmail: "",
  contactPhone: "",
  country: "",
  state: "",
  city: "",
  address: "",
  description: "",
};

export function InstitutionApplicationForm({
  defaultType,
  mode = "new",
  applicationId,
  initial,
}: {
  defaultType: string;
  mode?: "new" | "draft" | "response";
  /** Required in "draft" / "response" mode — the applicant's own row id. */
  applicationId?: string;
  /** Stored values to pre-fill (draft resume / response correction). */
  initial?: FieldValues;
}) {
  const router = useRouter();
  const [values, setValues] = useState<FieldValues>(
    initial ?? { ...EMPTY, institutionType: defaultType },
  );
  const [responseNote, setResponseNote] = useState("");
  const [errors, setErrors] = useState<
    Partial<Record<ApplicationResponseField, string>>
  >({});
  const [message, setMessage] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<null | "submit" | "draft">(null);

  const busy = pending !== null;

  function update(key: ApplicationSubmissionField, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function applyFailure(
    result: SubmitApplicationResult | DraftSaveResult | RespondApplicationResult,
  ) {
    setPending(null);
    if (result.ok) return;
    if (result.errors) setErrors(result.errors);
    if (result.values) {
      const merged = result.values as FieldValues & { responseNote?: string };
      const { responseNote: note, ...fields } = merged;
      setValues(fields);
      if (typeof note === "string") setResponseNote(note);
    }
    setMessage(result.message ?? "Please review the highlighted fields.");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setPending("submit");
    setMessage(null);
    setSavedNotice(null);
    setErrors({});
    const result =
      mode === "response"
        ? await respondToInformationRequestAction({
            ...values,
            applicationId,
            responseNote,
          })
        : await submitInstitutionApplicationAction({
            ...values,
            ...(mode === "draft" && applicationId ? { draftId: applicationId } : {}),
          });
    if (result.ok) {
      // Re-read the server so the onboarding page swaps this form for the
      // truthful status view. Never fake the success state.
      router.refresh();
      return;
    }
    applyFailure(result);
  }

  async function handleSaveDraft() {
    if (busy) return;
    setPending("draft");
    setMessage(null);
    setSavedNotice(null);
    setErrors({});
    const result = await saveApplicationDraftAction(values);
    if (result.ok) {
      setPending(null);
      setSavedNotice("Draft saved. Nothing is submitted until you submit for review.");
      router.refresh();
      return;
    }
    applyFailure(result);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {message ? (
        <Alert variant="danger" title={mode === "response" ? "Response not recorded" : "Application not submitted"}>
          {message}
        </Alert>
      ) : null}
      {savedNotice ? (
        <Alert variant="success" title="Draft saved">
          {savedNotice}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Institution name"
          required
          value={values.institutionName}
          onChange={(e) => update("institutionName", e.target.value)}
          error={errors.institutionName}
          maxLength={160}
        />
        <Select
          label="Institution type"
          required
          value={values.institutionType}
          onChange={(e) => update("institutionType", e.target.value)}
          error={errors.institutionType}
        >
          <option value="">Choose a type…</option>
          {INSTITUTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {institutionTypeLabel(type)}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Contact person"
          required
          value={values.contactPerson}
          onChange={(e) => update("contactPerson", e.target.value)}
          error={errors.contactPerson}
          maxLength={120}
        />
        <Input
          label="Contact email"
          type="email"
          required
          value={values.contactEmail}
          onChange={(e) => update("contactEmail", e.target.value)}
          error={errors.contactEmail}
          maxLength={254}
        />
      </div>

      <Input
        label="Contact phone"
        required
        inputMode="tel"
        placeholder="+234 803 123 4567"
        value={values.contactPhone}
        onChange={(e) => update("contactPhone", e.target.value)}
        error={errors.contactPhone}
        description="Include your country code, e.g. +234…"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Input
          label="Country"
          required
          value={values.country}
          onChange={(e) => update("country", e.target.value)}
          error={errors.country}
          maxLength={60}
        />
        <Input
          label="State"
          required
          value={values.state}
          onChange={(e) => update("state", e.target.value)}
          error={errors.state}
          maxLength={60}
        />
        <Input
          label="City"
          required
          value={values.city}
          onChange={(e) => update("city", e.target.value)}
          error={errors.city}
          maxLength={80}
        />
      </div>

      <Input
        label="Full address"
        required
        value={values.address}
        onChange={(e) => update("address", e.target.value)}
        error={errors.address}
        maxLength={200}
      />

      <Textarea
        label="About your institution"
        required={false}
        rows={4}
        maxLength={500}
        value={values.description}
        onChange={(e) => update("description", e.target.value)}
        error={errors.description}
        description="Optional — what you teach, cohort sizes, or anything the review team should know."
      />

      {mode === "response" ? (
        <Textarea
          label="Your response to the review team"
          required
          rows={4}
          maxLength={1000}
          value={responseNote}
          onChange={(e) => {
            setResponseNote(e.target.value);
            setErrors((current) => ({ ...current, responseNote: undefined }));
          }}
          error={errors.responseNote}
          description="Answer the requested information above. You can also correct any detail below before resubmitting."
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="submit" disabled={busy}>
          {pending === "submit"
            ? "Submitting…"
            : mode === "response"
              ? "Submit response"
              : "Submit for review"}
        </Button>
        {mode !== "response" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={handleSaveDraft}
          >
            {pending === "draft" ? "Saving…" : "Save draft"}
          </Button>
        ) : null}
        <p className="text-xs text-ink-muted">
          {mode === "response"
            ? "Responding sends your answer back to the review queue. Access opens only after a super admin approves the application."
            : mode === "draft"
              ? "Saving a draft keeps your progress private — a super admin only sees the application once you submit it."
              : "Submitting sends your details to the PrepGrade review team. Your workspace opens only after a super admin approves the application."}
        </p>
      </div>
    </form>
  );
}
