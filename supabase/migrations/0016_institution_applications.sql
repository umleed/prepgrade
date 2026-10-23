-- ---------------------------------------------------------------------------
-- PrepGrade — 0016 institution applications (pending-approval queue)
--
-- WHY THIS EXISTS
-- The platform has NO durable "institution application" model today. The
-- demo-request form is a console-only dev placeholder that persists nothing
-- (app/demo-request/actions.ts), and institutions are created directly with
-- status='active' (0001/0008/0015). So an institution with status 'active' or
-- 'suspended' is an OPERATIONAL tenant, NOT an application awaiting approval —
-- conflating the two would be wrong. This migration adds the smallest durable
-- record that lets a real applicant submit an institution registration, see it
-- as pending, and have a SUPER_ADMIN approve or reject it before any workspace
-- access exists.
--
-- WHAT AN APPLICATION IS
-- A pre-tenant request. It is deliberately NOT a row in `institutions`: an
-- applicant has no tenant, no membership, and no workspace until an approved
-- decision creates one. On approval the platform inserts a real institution
-- (via the existing duplicate-safe createPlatformInstitution path, which
-- creates NO membership and sends NO email) and records its id in
-- approved_institution_id. Access provisioning (first admin invitation) is a
-- separate, unbuilt workflow — so approval never grants workspace access on its
-- own here (AGENTS.md §5: do not create membership / access before approval).
--
-- STATUS (the application lifecycle, distinct from institutions.status):
--   pending_review    : submitted, awaiting a decision (the default).
--   needs_information : a super admin asked the applicant for more detail.
--   approved          : terminal — accepted, tenant created.
--   rejected          : terminal — declined, with a recorded reason.
--   Only the application code (lib/institution-applications.ts) defines the
--   legal transitions; this CHECK is the storage-level backstop.
--
-- DUPLICATE / RACE PREVENTION:
--   * applicant_open_unique_idx — one OPEN application (pending_review or
--     needs_information) per signed-in applicant. A second submission while one
--     is open is refused at the database, so an impatient or scripted user
--     cannot pile up parallel applications for the same request.
--   * Concurrent decisions are serialised in the data layer by a compare-and-
--     swap on status (the write is conditional on the status just read), so two
--     operators cannot both approve, or approve-and-reject, the same
--     application. approved_institution_id is set only by the CAS winner.
--   * The created institution still carries 0015's name-uniqueness, so an
--     approval can never mint a duplicate tenant.
--
-- PRIVACY (AGENTS.md §7): the applicant fields are business-contact data for
-- the prospective tenant (the person submitting the registration) — the
-- minimum that makes an application reviewable and the applicant reachable.
-- applicant_user_id is the Clerk user id (same identity key as profiles.id),
-- used only to attribute the applicant's own submission and to enforce the
-- one-open-application rule; it is never a client-supplied authorization input.
--
-- TENANT ISOLATION: an application is a pre-tenant record with no owning
-- institution yet, so there is no cross-tenant read to scope. It is read and
-- written ONLY through the service-role data layer behind the SUPER_ADMIN guard
-- (list/decide) or by the signed-in applicant (submit / read own status).
--
-- Apply via Supabase SQL editor or `supabase db push`. Idempotent via IF NOT
-- EXISTS so re-running during a pilot is safe.
--
-- RLS: enabled + forced with zero permissive policies and all grants revoked
-- from anon/authenticated (mirrors 0002/0007). service_role — the only key the
-- app uses — bypasses RLS and is the sole reader/writer; the SUPER_ADMIN guard
-- in the application code remains the enforcement point.
--
-- ROLLBACK (destructive — drops the queue; do it only where the data can be
-- rebuilt):
--   DROP INDEX IF EXISTS applicant_open_unique_idx;
--   DROP TABLE IF EXISTS institution_applications;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS institution_applications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Applicant identity (Clerk user id; nullable only for a hypothetical
  -- unauthenticated submission, which the app does not currently allow).
  applicant_user_id text CHECK (
    applicant_user_id IS NULL OR char_length(btrim(applicant_user_id)) BETWEEN 1 AND 100
  ),

  -- What is being requested.
  institution_name  text NOT NULL CHECK (char_length(btrim(institution_name)) BETWEEN 1 AND 160),
  institution_type  text NOT NULL CHECK (institution_type IN ('school', 'tutorial_centre', 'cbt_centre')),

  -- Business contact / location for the prospective tenant (bounds mirror the
  -- registration profile CHECKs in 0015 and lib/institution-applications.ts).
  contact_person    text NOT NULL CHECK (char_length(btrim(contact_person)) BETWEEN 1 AND 120),
  contact_email     text NOT NULL CHECK (
    char_length(btrim(contact_email)) BETWEEN 3 AND 254
    AND contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  contact_phone     text NOT NULL CHECK (
    char_length(btrim(contact_phone)) BETWEEN 8 AND 16
    AND contact_phone ~ '^\+?[0-9]{8,15}$'
  ),
  country           text NOT NULL CHECK (char_length(btrim(country)) BETWEEN 1 AND 60),
  state             text NOT NULL CHECK (char_length(btrim(state)) BETWEEN 1 AND 60),
  city              text NOT NULL CHECK (char_length(btrim(city)) BETWEEN 1 AND 80),
  address           text NOT NULL CHECK (char_length(btrim(address)) BETWEEN 1 AND 200),
  description       text
    CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 500),

  -- Application lifecycle (the review queue's status, NOT institutions.status).
  status            text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'needs_information', 'approved', 'rejected')),

  -- Decision record. Populated only by an authorised SUPER_ADMIN decision.
  decided_by        text CHECK (decided_by IS NULL OR char_length(btrim(decided_by)) BETWEEN 1 AND 100),
  decided_at        timestamptz,
  -- Required when rejected; carries the reason the applicant sees.
  rejection_reason  text CHECK (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 1 AND 500),
  -- Required when moving to needs_information; what the admin asked for.
  info_request_note text CHECK (info_request_note IS NULL OR char_length(btrim(info_request_note)) BETWEEN 1 AND 500),
  -- The tenant created on approval (no membership / access implied).
  approved_institution_id uuid REFERENCES institutions(id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Review queue is scanned/filtered by status and sorted newest-first; the
-- directory search matches the institution name.
CREATE INDEX IF NOT EXISTS institution_applications_status_idx
  ON institution_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS institution_applications_created_idx
  ON institution_applications (created_at DESC);
CREATE INDEX IF NOT EXISTS institution_applications_name_idx
  ON institution_applications (lower(btrim(institution_name)));

-- One OPEN application per signed-in applicant (duplicate-submission guard).
-- A decided (approved/rejected) application frees the applicant to submit a
-- fresh one, so the index is partial over the two open statuses only.
CREATE UNIQUE INDEX IF NOT EXISTS applicant_open_unique_idx
  ON institution_applications (lower(btrim(applicant_user_id)))
  WHERE status IN ('pending_review', 'needs_information')
    AND applicant_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS institution_applications_set_updated_at ON institution_applications;
CREATE TRIGGER institution_applications_set_updated_at
  BEFORE UPDATE ON institution_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Deny-by-default for browser roles (mirrors 0002 / 0007) ----------------
ALTER TABLE institution_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution_applications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON institution_applications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON institution_applications TO service_role;
