-- ===========================================================================
-- PrepGrade — Institution applications readiness harness (pending approvals)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code cannot assert without a database (migrations 0016 + 0019):
--     * institution_applications exists with the review-queue columns and
--       defaults status to 'pending_review'
--     * the status / institution_type / contact CHECKs refuse unknown or
--       malformed values, mirroring lib/institution-applications.ts
--     * SUBMITTED rows must carry the full business record (0019
--       full_when_not_draft); drafts may be partial but count as OPEN
--     * applicant_open_unique_idx allows only ONE open application per
--       applicant (draft included), but frees the applicant once their
--       application is decided, and never couples two different applicants
--     * approved_institution_id is a real FK into institutions (SET NULL)
--     * RLS is enabled + forced and the browser roles have no privileges — the
--       service-role data layer behind the SUPER_ADMIN guard is the only path
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply migrations 0001–0019.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/institution_applications_readiness.sql
--      or  supabase db query --linked -f supabase/tests/institution_applications_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so
--   no rows persist regardless of pass/fail. If your SQL editor auto-commits,
--   run it through `psql` instead so the transaction holds.
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
  vid uuid;
BEGIN
  -- ------------------------------------------------------------------
  -- 1. The queue table + its columns exist (0016 applied).
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'institution_applications'
      AND column_name IN ('applicant_user_id','institution_name','institution_type',
                          'contact_person','contact_email','contact_phone','country',
                          'state','city','address','description','status','decided_by',
                          'decided_at','rejection_reason','info_request_note',
                          'hold_note','applicant_response_note','responded_at',
                          'approved_institution_id');
  IF n < 20 THEN
    RAISE EXCEPTION 'FAIL: institution_applications missing column(s) (found % of 20); apply 0016 + 0019', n;
  END IF;
  RAISE NOTICE 'PASS: institution_applications has all review-queue + lifecycle columns';

  -- ------------------------------------------------------------------
  -- 2. A minimal submission defaults status to 'pending_review'.
  -- ------------------------------------------------------------------
  INSERT INTO institution_applications (
      applicant_user_id, institution_name, institution_type,
      contact_person, contact_email, contact_phone,
      country, state, city, address
    ) VALUES (
      'user_probe_open_1', 'Greenfield Tutorial Centre', 'tutorial_centre',
      'Ngozi Okafor', 'admin@greenfield.example.test', '+2348031234567',
      'Nigeria', 'Lagos', 'Ikeja', '14 Allen Avenue'
    )
    RETURNING id INTO vid;
  SELECT status INTO v FROM institution_applications WHERE id = vid;
  IF v <> 'pending_review' THEN
    RAISE EXCEPTION 'FAIL: new application defaulted to % (expected pending_review)', v;
  END IF;
  RAISE NOTICE 'PASS: new application defaults to pending_review';

  -- ------------------------------------------------------------------
  -- 3. CHECK constraints refuse out-of-vocabulary / malformed values.
  -- ------------------------------------------------------------------
  BEGIN
    INSERT INTO institution_applications (
        institution_name, institution_type, contact_person, contact_email,
        contact_phone, country, state, city, address
      ) VALUES (
        'Bad Type Probe', 'university', 'A B', 'a@b.example.test',
        '+2348031234567', 'Nigeria', 'S', 'C', 'Addr'
      );
    RAISE EXCEPTION 'FAIL: institution_type CHECK accepted an unknown value';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: institution_type CHECK refuses unknown types';
  END;

  BEGIN
    INSERT INTO institution_applications (
        institution_name, institution_type, status, contact_person, contact_email,
        contact_phone, country, state, city, address
      ) VALUES (
        'Bad Status Probe', 'school', 'active', 'A B', 'a@b.example.test',
        '+2348031234567', 'Nigeria', 'S', 'C', 'Addr'
      );
    RAISE EXCEPTION 'FAIL: status CHECK accepted a non-application status';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: status CHECK refuses an operational (non-application) status';
  END;

  BEGIN
    INSERT INTO institution_applications (
        institution_name, institution_type, contact_person, contact_email,
        contact_phone, country, state, city, address
      ) VALUES (
        'Bad Email Probe', 'school', 'A B', 'not-an-email',
        '+2348031234567', 'Nigeria', 'S', 'C', 'Addr'
      );
    RAISE EXCEPTION 'FAIL: contact_email CHECK accepted a malformed address';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: contact_email CHECK refuses malformed addresses';
  END;

  BEGIN
    INSERT INTO institution_applications (
        institution_name, institution_type, contact_person, contact_email,
        contact_phone, country, state, city, address
      ) VALUES (
        'Bad Phone Probe', 'school', 'A B', 'a@b.example.test',
        '+234abc1234', 'Nigeria', 'S', 'C', 'Addr'
      );
    RAISE EXCEPTION 'FAIL: contact_phone CHECK accepted letters';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: contact_phone CHECK refuses non-digit phones';
  END;

  BEGIN
    INSERT INTO institution_applications (
        institution_type, contact_person, contact_email, contact_phone,
        country, state, city, address
      ) VALUES (
        'school', 'A B', 'a@b.example.test', '+2348031234567',
        'Nigeria', 'S', 'C', 'Addr'
      );
    RAISE EXCEPTION 'FAIL: a submitted row without institution_name was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: submitted (non-draft) rows refuse missing business fields (0019)';
  END;

  -- A DRAFT may be partial — only the name is needed to keep it identifiable.
  INSERT INTO institution_applications (
      applicant_user_id, institution_name, status
    ) VALUES (
      'user_probe_draft_1', 'Ridge CBT Hub', 'draft'
    );
  RAISE NOTICE 'PASS: partial drafts are stored (pre-submission is a real state)';

  -- A draft still counts as the applicant's ONE open application (0019 index).
  BEGIN
    INSERT INTO institution_applications (
        applicant_user_id, institution_name, institution_type, contact_person,
        contact_email, contact_phone, country, state, city, address
      ) VALUES (
        'user_probe_draft_1', 'Ridge Second Attempt', 'cbt_centre',
        'A B', 'c@d.example.test', '+2348031234569',
        'Nigeria', 'S', 'C', 'Addr'
      );
    RAISE EXCEPTION 'FAIL: a second OPEN application beside a draft was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: draft blocks a duplicate open application too';
  END;

  -- on_hold is a legal status and the response columns accept bounded values.
  -- (A full record: only drafts may be partial — flipping a bare draft to
  -- on_hold would itself break full_when_not_draft.)
  INSERT INTO institution_applications (
      applicant_user_id, institution_name, institution_type, contact_person,
      contact_email, contact_phone, country, state, city, address, status
    ) VALUES (
      'user_probe_hold_1', 'Valley View School', 'school',
      'A B', 'c@d.example.test', '+2348031234569',
      'Nigeria', 'Oyo', 'Ibadan', '5 Ring Road', 'on_hold'
    );
  UPDATE institution_applications
    SET hold_note = 'Awaiting verification call.'
    WHERE applicant_user_id = 'user_probe_hold_1';
  UPDATE institution_applications
    SET applicant_response_note = 'Call confirmed for tomorrow.',
        responded_at = now()
    WHERE applicant_user_id = 'user_probe_hold_1';
  SELECT count(*) INTO n FROM institution_applications
    WHERE applicant_user_id = 'user_probe_hold_1'
      AND status = 'on_hold' AND hold_note IS NOT NULL
      AND applicant_response_note IS NOT NULL AND responded_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: on_hold / response columns did not persist as written';
  END IF;
  RAISE NOTICE 'PASS: on_hold status + applicant response persist';

  -- ------------------------------------------------------------------
  -- 4. One OPEN application per applicant (partial unique index).
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'institution_applications'
      AND indexname = 'applicant_open_unique_idx';
  IF n < 1 THEN
    RAISE EXCEPTION 'FAIL: applicant_open_unique_idx is missing';
  END IF;
  RAISE NOTICE 'PASS: applicant_open_unique_idx exists';

  BEGIN
    INSERT INTO institution_applications (
        applicant_user_id, institution_name, institution_type, contact_person,
        contact_email, contact_phone, country, state, city, address
      ) VALUES (
        'user_probe_open_1', 'Greenfield Second Attempt', 'tutorial_centre',
        'Ngozi Okafor', 'admin@greenfield.example.test', '+2348031234567',
        'Nigeria', 'Lagos', 'Ikeja', '14 Allen Avenue'
      );
    RAISE EXCEPTION 'FAIL: a second OPEN application for the same applicant was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: duplicate OPEN application is refused';
  END;

  -- Deciding the first application frees the applicant to submit a fresh one.
  UPDATE institution_applications
    SET status = 'rejected', rejection_reason = 'Incomplete documentation.'
    WHERE applicant_user_id = 'user_probe_open_1';
  INSERT INTO institution_applications (
      applicant_user_id, institution_name, institution_type, contact_person,
      contact_email, contact_phone, country, state, city, address
    ) VALUES (
      'user_probe_open_1', 'Greenfield Reapplied', 'tutorial_centre',
      'Ngozi Okafor', 'admin@greenfield.example.test', '+2348031234567',
      'Nigeria', 'Lagos', 'Ikeja', '14 Allen Avenue'
    );
  RAISE NOTICE 'PASS: after a decision the applicant may submit a new application';

  -- A different applicant's OPEN application is unaffected by the first.
  INSERT INTO institution_applications (
      applicant_user_id, institution_name, institution_type, contact_person,
      contact_email, contact_phone, country, state, city, address
    ) VALUES (
      'user_probe_open_2', 'Riverside School', 'school',
      'Tari Okin', 'head@riverside.example.test', '+2348031234568',
      'Nigeria', 'Rivers', 'Port Harcourt', '10 Aba Road'
    );
  RAISE NOTICE 'PASS: two applicants keep independent open applications';

  -- ------------------------------------------------------------------
  -- 5. approved_institution_id is a real FK into institutions.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_namespace ns ON ns.oid = c.connamespace
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class ft ON ft.oid = c.confrelid
    WHERE ns.nspname = 'public' AND t.relname = 'institution_applications'
      AND c.contype = 'f' AND ft.relname = 'institutions';
  IF n < 1 THEN
    RAISE EXCEPTION 'FAIL: approved_institution_id is not a FK into institutions';
  END IF;
  RAISE NOTICE 'PASS: approved_institution_id references institutions';

  -- ------------------------------------------------------------------
  -- 6. RLS is on + forced, and browser roles are denied outright.
  -- ------------------------------------------------------------------
  SELECT (relrowsecurity AND relforcerowsecurity) INTO ok
    FROM pg_class WHERE oid = 'institution_applications'::regclass;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: RLS is not enabled+forced on institution_applications';
  END IF;
  RAISE NOTICE 'PASS: RLS is enabled and forced';

  -- 6a. anon cannot SELECT (grant revoked AND no policies).
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM count(*) FROM institution_applications;
    RAISE EXCEPTION 'FAIL: anon read the applications table';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon denied SELECT';
  END;
  RESET ROLE;

  -- 6b. authenticated cannot INSERT (a browser cannot mint applications directly).
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO institution_applications (
        institution_name, institution_type, contact_person, contact_email,
        contact_phone, country, state, city, address
      ) VALUES (
        'Browser Forge', 'school', 'A B', 'a@b.example.test',
        '+2348031234567', 'Nigeria', 'S', 'C', 'Addr'
      );
    RAISE EXCEPTION 'FAIL: authenticated wrote to the applications table';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated denied INSERT';
  END;
  RESET ROLE;
END $$;

ROLLBACK;
