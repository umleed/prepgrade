-- ---------------------------------------------------------------------------
-- PrepGrade — 0017 applicant access provisioning (post-approval)
--
-- WHY THIS EXISTS
-- 0016 deliberately deferred "first admin invitation" ("Access provisioning is
-- a separate, unbuilt workflow"), so approving an application created the
-- tenant but left the applicant with NO institution membership and NO trusted
-- Clerk role. The auth stack (lib/auth/context.ts → principal.ts) reads ONLY
-- Clerk `privateMetadata` (role + institutionId), and /institution requires
-- INSTITUTION_ADMIN — so an approved applicant kept seeing "No institution
-- membership yet". This migration records the outcome of the now-implemented
-- provisioning step so it is durable, idempotent, and safely retryable.
--
-- WHAT IS ADDED (all on institution_applications; additive + idempotent)
--   provisioning_status : the recoverable state of granting the applicant's
--     workspace access. Only meaningful once status = 'approved'.
--       not_required : not approved yet (pending_review / needs_information /
--                      rejected), OR an approved row written before this
--                      column existed and not yet provisioned. The safe
--                      "access not granted" default.
--       provisioned  : membership + trusted Clerk role both written; the
--                      applicant can open their institution dashboard.
--       needs_retry  : approval succeeded but a provisioning step failed
--                      (e.g. the Clerk write failed after the membership
--                      landed). An authorised SUPER_ADMIN can retry; the
--                      operation is idempotent (no duplicate tenant / member).
--   provisioning_error  : a SHORT controlled reason token (see
--     lib/institution-applications.ts PROVISIONING_ERROR_CODES) so an operator
--     can see WHICH step to retry. PRIVACY: never free text, an email, a name,
--     or a raw error/stack (AGENTS.md §7).
--   provisioned_at      : when access became fully ready (null until then).
--
-- SECURITY: this adds NO new reader/writer. The columns live on the same table,
-- which stays deny-by-default for anon/authenticated and is written ONLY through
-- the service-role data layer behind the SUPER_ADMIN guard (0016). The applicant
-- identity used for provisioning is the row's own applicant_user_id (a Clerk user
-- id, same key as profiles.id) — never a client-supplied authorization input.
--
-- Apply via Supabase SQL editor or `supabase db push`. Idempotent via IF NOT
-- EXISTS / ADD COLUMN IF NOT EXISTS so re-running during a pilot is safe.
--
-- ROLLBACK (destructive):
--   ALTER TABLE institution_applications
--     DROP COLUMN IF EXISTS provisioning_status,
--     DROP COLUMN IF EXISTS provisioning_error,
--     DROP COLUMN IF EXISTS provisioned_at;
-- ---------------------------------------------------------------------------

ALTER TABLE institution_applications
  ADD COLUMN IF NOT EXISTS provisioning_status text NOT NULL DEFAULT 'not_required'
    CHECK (provisioning_status IN ('not_required', 'provisioned', 'needs_retry'));

ALTER TABLE institution_applications
  ADD COLUMN IF NOT EXISTS provisioning_error text
    CHECK (
      provisioning_error IS NULL
      OR provisioning_error IN (
        'applicant_missing', 'tenant_missing', 'role_conflict',
        'membership_write_failed', 'clerk_metadata_failed'
      )
    );

ALTER TABLE institution_applications
  ADD COLUMN IF NOT EXISTS provisioned_at timestamptz;

-- Keep the two provisioning flags consistent with the decision: a non-approved
-- application must never claim to be provisioned (fail-closed at the storage
-- layer, mirroring the CHECKs elsewhere). Approved rows are the only ones that
-- may carry 'provisioned'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'institution_applications_provisioning_requires_approval'
      AND conrelid = 'institution_applications'::regclass
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE institution_applications
    ADD CONSTRAINT institution_applications_provisioning_requires_approval
    CHECK (
      provisioning_status = 'not_required'
      OR status = 'approved'
    );
END $$;

-- Surface approved-but-unprovisioned rows for the review queue's retry affordance.
CREATE INDEX IF NOT EXISTS institution_applications_provisioning_idx
  ON institution_applications (provisioning_status)
  WHERE status = 'approved';
