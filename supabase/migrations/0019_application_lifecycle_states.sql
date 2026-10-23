-- ---------------------------------------------------------------------------
-- PrepGrade — 0019 application lifecycle states (draft / on hold) + applicant response
--
-- WHY THIS EXISTS
-- 0016/0017 give the review queue its core lifecycle (pending_review /
-- needs_information / approved / rejected + provisioning outcome), but three
-- required product behaviours cannot be represented yet:
--   * DRAFT — an applicant can start an application and save it WITHOUT
--     submitting. Today every write is an immediate submission, so a partly
--     filled application has nowhere to live.
--   * ON HOLD — a super admin can pause a review while verification is stalled.
--     The catalog has no paused state, so "on hold" collapses into
--     needs_information and loses the distinction.
--   * APPLICANT RESPONSE — a needs_information request is currently a dead
--     end: the one-open-application index blocks a duplicate submission and
--     there is no way to answer the request on the existing row. The applicant
--     cannot progress and the reviewer cannot see that an answer arrived.
-- This migration is FORWARD-ONLY and additive; nothing in 0001–0018 is
-- rewritten or dropped. institutions.status (active/suspended/archived) is
-- NOT touched — the application lifecycle stays separate from the institution
-- lifecycle (0016 rationale still holds).
--
-- STATUS (extends the 0016 CHECK; still NOT institutions.status)
--   draft             : started, NOT yet submitted. Invisible to the review
--                       queue; only the owning applicant can read/write it.
--   pending_review    : submitted, awaiting a decision (unchanged).
--   needs_information : reviewer asked for more detail; the applicant may now
--                       RESPOND (see below), which moves it back to
--                       pending_review (serialised in the data layer by CAS).
--   on_hold           : review PAUSED by a super admin with a recorded reason.
--                       Not a rejection; the reviewer may later request
--                       information, approve, or reject from here.
--   approved / rejected : terminal, unchanged.
--
-- APPLICANT RESPONSE (the needs_information loop)
--   applicant_response_note : what the applicant supplied in answer to the
--     reviewer's request. Required when answering; bounded like every note.
--   responded_at            : when the answer was recorded (timeline data).
--   info_request_note stays as the reviewer's ask (the applicant sees both),
--   so a request is never silently replaced by an answer.
--   put_on_hold writes its reason to hold_note (kept separate from
--   info_request_note so the two reviewer messages never overwrite each other).
--
-- COMPLETENESS AT THE STORAGE LEVEL
-- Drafts may be partial, so the 0016 NOT NULLs on the business fields are
-- relaxed; the per-column CHECK bounds still apply to every value PRESENT.
-- A table CHECK replaces the NOT NULLs for anything beyond draft: a
-- non-draft row MUST carry the full business record — a draft can never
-- "sneak" into the review queue with missing fields, because the queue only
-- ever sees submitted rows and the database refuses to store them.
--
-- DUPLICATE GUARD (updated)
-- One OPEN application per applicant now covers draft, pending_review,
-- needs_information, AND on_hold — so saving a draft next to a pending
-- application, answering twice in parallel, or re-applying while a held
-- review exists are all refused at the database. Terminal (approved /
-- rejected) rows still free the applicant to submit a fresh application.
--
-- PRIVACY / TENANT ISOLATION: unchanged from 0016 — deny-by-default for
-- anon/authenticated, service-role only, SUPER_ADMIN guard (reviewer side) or
-- the applicant's own trusted Clerk id (applicant side). No new readers.
--
-- Apply via Supabase SQL editor or `supabase db push` (ONLY after explicit
-- approval — this repository never pushes remote migrations silently).
-- Idempotent: every statement is IF-NOT-EXISTS / DROP-IF-EXISTS style.
--
-- ROLLBACK (destructive — re-tightens the model; only where the new-state
-- rows can be re-homed):
--   ALTER TABLE institution_applications
--     DROP CONSTRAINT IF EXISTS institution_applications_status_check,
--     DROP CONSTRAINT IF EXISTS institution_applications_full_when_not_draft,
--     ADD CONSTRAINT institution_applications_status_check
--       CHECK (status IN ('pending_review','needs_information','approved','rejected')),
--     ALTER TABLE institution_applications
--       DROP COLUMN IF EXISTS hold_note,
--       DROP COLUMN IF EXISTS applicant_response_note,
--       DROP COLUMN IF EXISTS responded_at;
--   (the NOT NULLs and the 0016 partial index can then be recreated as-is)
-- ---------------------------------------------------------------------------

-- 1) Status catalog: drop the 0016 inline CHECK and re-add the extended one.
ALTER TABLE institution_applications
  DROP CONSTRAINT IF EXISTS institution_applications_status_check;
ALTER TABLE institution_applications
  ADD CONSTRAINT institution_applications_status_check
  CHECK (status IN (
    'draft', 'pending_review', 'needs_information', 'on_hold',
    'approved', 'rejected'
  ));

-- 2) Partial drafts: relax the business-field NOT NULLs (bounds CHECKs stay).
-- `ALTER COLUMN ... DROP NOT NULL` is the correct Postgres form and is a
-- no-op when the column is already nullable, so re-running stays safe. (A
-- `DROP IF EXISTS NOT NULL` variant is invalid syntax and aborts the file.)
ALTER TABLE institution_applications ALTER COLUMN institution_name DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN institution_type DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN contact_person   DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN contact_email    DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN contact_phone    DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN country          DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN state            DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN city             DROP NOT NULL;
ALTER TABLE institution_applications ALTER COLUMN address          DROP NOT NULL;

-- A draft is the ONLY row allowed to be partial; anything submitted (or
-- decided) must be a complete business record. This is the storage-level
-- mirror of validateApplicationSubmission in lib/institution-applications.ts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'institution_applications_full_when_not_draft'
      AND conrelid = 'institution_applications'::regclass
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE institution_applications
    ADD CONSTRAINT institution_applications_full_when_not_draft
    CHECK (
      status = 'draft'
      OR (
        institution_name   IS NOT NULL
        AND institution_type IS NOT NULL
        AND contact_person   IS NOT NULL
        AND contact_email    IS NOT NULL
        AND contact_phone    IS NOT NULL
        AND country          IS NOT NULL
        AND state            IS NOT NULL
        AND city             IS NOT NULL
        AND address          IS NOT NULL
      )
    );
END
$$;

-- 3) Reviewer hold reason + applicant response (bounded like the other notes).
ALTER TABLE institution_applications
  ADD COLUMN IF NOT EXISTS hold_note text
    CHECK (hold_note IS NULL OR char_length(btrim(hold_note)) BETWEEN 1 AND 500);

ALTER TABLE institution_applications
  ADD COLUMN IF NOT EXISTS applicant_response_note text
    CHECK (applicant_response_note IS NULL OR char_length(btrim(applicant_response_note)) BETWEEN 1 AND 1000);

ALTER TABLE institution_applications
  ADD COLUMN IF NOT EXISTS responded_at timestamptz;

-- 4) One OPEN application per applicant — now covering draft + on_hold.
--    (Recreated so the partial-index predicate includes the new open states.)
DROP INDEX IF EXISTS applicant_open_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS applicant_open_unique_idx
  ON institution_applications (lower(btrim(applicant_user_id)))
  WHERE status IN ('draft', 'pending_review', 'needs_information', 'on_hold')
    AND applicant_user_id IS NOT NULL;
