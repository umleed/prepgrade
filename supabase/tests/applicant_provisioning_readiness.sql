-- ===========================================================================
-- PrepGrade — Applicant access provisioning readiness harness (migration 0017)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   SERVER-ONLY provisioning code cannot assert without a database:
--     * 0017 added provisioning_status / provisioning_error / provisioned_at
--     * provisioning_status defaults to 'not_required' (the safe "access not
--       granted" reading) and error/at start NULL
--     * a NON-approved application can NEVER claim provisioning
--       (institution_applications_provisioning_requires_approval), while an
--       approved row can be marked provisioned — the fail-closed storage rule
--     * provisioning_status and provisioning_error are CLOSED vocabularies
--       (an unknown status or a free-text reason is refused, mirroring
--       lib/institution-applications.ts)
--     * institution_memberships accepts INSTITUTION_ADMIN, refuses a role
--       outside its CHECK, and its UNIQUE (institution_id, user_id) makes a
--       provisioning RETRY non-duplicating
--     * a membership requires a backing profiles row (the FK the provisioning
--       flow satisfies by mirroring the Clerk account first)
--     * institution_applications stays RLS-enabled+forced and the browser roles
--       cannot re-write provisioning state — the SUPER_ADMIN-guarded
--       service-role data layer is the only writer
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply migrations 0001–0017.
--   2. Run this whole file through psql (NOT an auto-committing editor, so the
--      transaction holds and every probe rolls back):
--        psql "$DATABASE_URL" -f supabase/tests/applicant_provisioning_readiness.sql
--      or  supabase db query --linked -f supabase/tests/applicant_provisioning_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction ending in ROLLBACK, so no
--   rows persist regardless of pass/fail. Positive probes rely on the connected
--   role bypassing RLS (the Supabase `postgres` / service path); the negative
--   RLS probe switches to the `authenticated` browser role to confirm denial.
--
-- Output: one `NOTICE` line per check (PASS). Any hard assertion failure RAISEs
-- an exception and aborts (transaction rolls back) — the intended "red" result.
-- ===========================================================================

BEGIN;

DO $$
DECLARE
  ok  boolean;
  n   int;
  v   text;
  vid uuid;   -- institutions.id
  aid uuid;   -- institution_applications.id
BEGIN
  -- ------------------------------------------------------------------
  -- 1. 0017 columns exist.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'institution_applications'
      AND column_name IN ('provisioning_status','provisioning_error','provisioned_at');
  IF n < 3 THEN
    RAISE EXCEPTION 'FAIL: institution_applications missing provisioning column(s) (found % of 3); apply 0017', n;
  END IF;
  RAISE NOTICE 'PASS: 0017 provisioning columns exist';

  -- ------------------------------------------------------------------
  -- 2. A fresh application defaults to 'not_required' with no error / timestamp.
  -- ------------------------------------------------------------------
  INSERT INTO institution_applications (
      applicant_user_id, institution_name, institution_type, contact_person,
      contact_email, contact_phone, country, state, city, address
    ) VALUES (
      'user_prov_pending', 'Greenfield Pending', 'tutorial_centre',
      'Ngozi Okafor', 'admin@greenfield.example.test', '+2348031234567',
      'Nigeria', 'Lagos', 'Ikeja', '14 Allen Avenue'
    )
    RETURNING id INTO aid;

  SELECT provisioning_status INTO v FROM institution_applications WHERE id = aid;
  IF v <> 'not_required' THEN
    RAISE EXCEPTION 'FAIL: default provisioning_status is "%", expected not_required', v;
  END IF;
  SELECT (provisioning_error IS NULL AND provisioned_at IS NULL) INTO ok
    FROM institution_applications WHERE id = aid;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: a fresh application did not start with null error / provisioned_at';
  END IF;
  RAISE NOTICE 'PASS: not_required is the safe default (error/at null)';

  -- ------------------------------------------------------------------
  -- 3. A NON-approved application can never claim provisioning (fail-closed).
  -- ------------------------------------------------------------------
  BEGIN
    UPDATE institution_applications SET provisioning_status = 'provisioned' WHERE id = aid;
    RAISE EXCEPTION 'FAIL: a pending application was allowed to claim provisioned access';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only an approved row may carry provisioning state';
  END;

  -- ------------------------------------------------------------------
  -- 4. An APPROVED row can be marked provisioned (the happy path).
  -- ------------------------------------------------------------------
  UPDATE institution_applications SET status = 'approved' WHERE id = aid;
  UPDATE institution_applications
    SET provisioning_status = 'provisioned', provisioned_at = now()
    WHERE id = aid;
  RAISE NOTICE 'PASS: an approved application can be marked provisioned';

  -- ------------------------------------------------------------------
  -- 5. provisioning_status is a CLOSED set (unknown value refused).
  -- ------------------------------------------------------------------
  BEGIN
    UPDATE institution_applications SET provisioning_status = 'half_provisioned' WHERE id = aid;
    RAISE EXCEPTION 'FAIL: an unknown provisioning_status was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: provisioning_status is a closed vocabulary';
  END;

  -- ------------------------------------------------------------------
  -- 6. provisioning_error is a controlled token, never free text; NULL allowed.
  -- ------------------------------------------------------------------
  BEGIN
    UPDATE institution_applications SET provisioning_error = 'ConnectionError at line 42' WHERE id = aid;
    RAISE EXCEPTION 'FAIL: a free-text provisioning_error was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: provisioning_error is a controlled vocabulary';
  END;
  UPDATE institution_applications SET provisioning_error = 'clerk_metadata_failed' WHERE id = aid;
  UPDATE institution_applications SET provisioning_error = NULL WHERE id = aid;
  RAISE NOTICE 'PASS: a controlled error token is accepted and can be cleared';

  -- ------------------------------------------------------------------
  -- 7. Membership accepts INSTITUTION_ADMIN and refuses an out-of-catalog role.
  -- ------------------------------------------------------------------
  INSERT INTO institutions (name) VALUES ('Greenfield Provisioned') RETURNING id INTO vid;
  INSERT INTO profiles (id, email, full_name, account_type)
    VALUES ('user_prov_admin', 'admin@greenfield.example.test', 'Ngozi Okafor', 'school');
  INSERT INTO institution_memberships (institution_id, user_id, role, status)
    VALUES (vid, 'user_prov_admin', 'INSTITUTION_ADMIN', 'active');
  RAISE NOTICE 'PASS: the first INSTITUTION_ADMIN membership can be written';

  BEGIN
    INSERT INTO profiles (id, email, full_name, account_type)
      VALUES ('user_prov_bogus', 'bogus@example.test', 'Bogus', 'school');
    INSERT INTO institution_memberships (institution_id, user_id, role, status)
      VALUES (vid, 'user_prov_bogus', 'SUPER_USER', 'active');
    RAISE EXCEPTION 'FAIL: an out-of-catalog membership role was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: membership role is a closed vocabulary';
  END;

  -- ------------------------------------------------------------------
  -- 8. Retry idempotency: a second membership for the SAME (tenant, user) is
  --    refused by the unique index, so re-provisioning never duplicates.
  -- ------------------------------------------------------------------
  BEGIN
    INSERT INTO institution_memberships (institution_id, user_id, role, status)
      VALUES (vid, 'user_prov_admin', 'INSTITUTION_ADMIN', 'active');
    RAISE EXCEPTION 'FAIL: a duplicate (institution,user) membership was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: duplicate membership refused (provisioning retry is non-duplicating)';
  END;

  -- ------------------------------------------------------------------
  -- 9. A membership requires a mirrored profile (FK) — the provisioning flow
  --    satisfies this by upserting profiles BEFORE the membership.
  -- ------------------------------------------------------------------
  BEGIN
    INSERT INTO institution_memberships (institution_id, user_id, role, status)
      VALUES (vid, 'user_no_profile', 'INSTITUTION_ADMIN', 'active');
    RAISE EXCEPTION 'FAIL: a membership without a backing profile was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: membership requires an existing profile (account mirror first)';
  END;

  -- ------------------------------------------------------------------
  -- 10. RLS stays on + forced, and the browser cannot re-write provisioning.
  -- ------------------------------------------------------------------
  SELECT (relrowsecurity AND relforcerowsecurity) INTO ok
    FROM pg_class WHERE oid = 'institution_applications'::regclass;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: RLS is not enabled+forced on institution_applications';
  END IF;
  RAISE NOTICE 'PASS: RLS is enabled and forced on the applications table';

  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE institution_applications SET provisioning_status = 'provisioned' WHERE id = aid;
    RAISE EXCEPTION 'FAIL: authenticated could re-write provisioning state from the browser';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated denied (access cannot be granted from the browser)';
  END;
  RESET ROLE;
END $$;

ROLLBACK;
