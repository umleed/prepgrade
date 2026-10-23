-- ===========================================================================
-- PrepGrade — Institution registration readiness harness (platform add-flow)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code cannot assert without a database (migration 0015):
--     * institutions has the profile/contact columns the registration form
--       writes (short_name, description, country, state, city, address,
--       contact_person, contact_email, contact_phone)
--     * they are nullable — a legacy tenant has no profile and must read
--       back as NULL (rendered "Not set", never guessed)
--     * the length/format CHECKs refuse out-of-range values, mirroring the
--       bounds in lib/institutions.ts validateInstitutionRegistration
--     * institutions_name_unique_idx exists and refuses a duplicate name
--       that differs only in case/outer whitespace — the exact equivalence
--       of normalizeInstitutionNameKey() and the server-side pre-check
--     * a platform-style full insert persists and defaults status to
--       'active' (the initial status the registration flow defines)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply migrations 0001–0015.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/institution_registration_readiness.sql
--      or  supabase db query --linked -f supabase/tests/institution_registration_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so
--   no rows persist regardless of pass/fail. If your SQL editor auto-commits,
--   run it through `psql` instead so the transaction holds.
--
-- Output: one `NOTICE` line per check (PASS/FAIL). Any hard assertion
-- failure RAISEs an exception and aborts (transaction rolls back), which is
-- the intended "red" result.
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
  -- 1. Columns exist (0015 applied).
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'institutions'
      AND column_name IN ('short_name','description','country','state',
                          'city','address','contact_person','contact_email',
                          'contact_phone');
  IF n < 9 THEN
    RAISE EXCEPTION 'FAIL: institutions missing registration column(s) (found % of 9); apply 0015', n;
  END IF;
  RAISE NOTICE 'PASS: institutions has all nine profile/contact columns';

  -- ------------------------------------------------------------------
  -- 2. A name-only insert leaves the profile NULL (legacy shape) and
  --    defaults status to 'active'.
  -- ------------------------------------------------------------------
  INSERT INTO institutions (name) VALUES ('PrepGrade Registration Legacy Probe')
    RETURNING id INTO vid;
  SELECT (short_name IS NULL AND country IS NULL AND contact_email IS NULL)
    INTO ok
    FROM institutions WHERE id = vid;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: profile columns did not default to NULL';
  END IF;
  SELECT status INTO v FROM institutions WHERE id = vid;
  IF v <> 'active' THEN
    RAISE EXCEPTION 'FAIL: new institution status defaulted to % (expected active)', v;
  END IF;
  RAISE NOTICE 'PASS: legacy-style insert has NULL profile and active status';

  -- ------------------------------------------------------------------
  -- 3. A full platform-registration insert persists every field.
  -- ------------------------------------------------------------------
  INSERT INTO institutions (
      name, institution_type, short_name, description,
      country, state, city, address,
      contact_person, contact_email, contact_phone
    ) VALUES (
      'PrepGrade Registration Full Probe', 'school', 'PRFP', 'Harness tenant.',
      'Nigeria', 'Borno', 'Maiduguri', 'No. 1, Harness Road',
      'Amina Bello', 'registrar@example.test', '+2348031234567'
    )
    RETURNING id INTO vid;

  SELECT contact_email || '|' || contact_phone || '|' || country
    INTO v
    FROM institutions WHERE id = vid;
  IF v <> 'registrar@example.test|+2348031234567|Nigeria' THEN
    RAISE EXCEPTION 'FAIL: registration profile did not persist intact (%)', v;
  END IF;
  RAISE NOTICE 'PASS: full registration profile persists';

  -- ------------------------------------------------------------------
  -- 4. CHECK bounds refuse out-of-range / malformed values.
  -- ------------------------------------------------------------------
  BEGIN
    INSERT INTO institutions (name, short_name)
      VALUES ('PrepGrade Reg CHECK probe 1', repeat('s', 41));
    RAISE EXCEPTION 'FAIL: short_name CHECK accepted a 41-char value';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: short_name CHECK refuses over-long values';
  END;

  BEGIN
    INSERT INTO institutions (name, contact_email)
      VALUES ('PrepGrade Reg CHECK probe 2', 'not-an-email');
    RAISE EXCEPTION 'FAIL: contact_email CHECK accepted a malformed address';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: contact_email CHECK refuses malformed addresses';
  END;

  BEGIN
    INSERT INTO institutions (name, contact_phone)
      VALUES ('PrepGrade Reg CHECK probe 3', '+234abc1234');
    RAISE EXCEPTION 'FAIL: contact_phone CHECK accepted letters';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: contact_phone CHECK refuses non-digits';
  END;

  BEGIN
    INSERT INTO institutions (name, country)
      VALUES ('PrepGrade Reg CHECK probe 4', repeat('c', 61));
    RAISE EXCEPTION 'FAIL: country CHECK accepted a 61-char value';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: country CHECK refuses over-long values';
  END;

  -- ------------------------------------------------------------------
  -- 5. Duplicate prevention: the unique index refuses a name that
  --    differs only in case or outer whitespace (lower(btrim(name))),
  --    and a distinct name still inserts cleanly.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'institutions'
      AND indexname = 'institutions_name_unique_idx';
  IF n < 1 THEN
    RAISE EXCEPTION 'FAIL: institutions_name_unique_idx is missing';
  END IF;
  RAISE NOTICE 'PASS: institutions_name_unique_idx exists';

  BEGIN
    INSERT INTO institutions (name)
      VALUES ('  PREPGRADE REGISTRATION FULL PROBE ');
    RAISE EXCEPTION 'FAIL: unique name index accepted a case/whitespace duplicate';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: duplicate name (case/trim-insensitive) is refused';
  END;

  INSERT INTO institutions (name) VALUES ('PrepGrade Registration Other Probe');
  RAISE NOTICE 'PASS: a distinct name still inserts';

  -- ------------------------------------------------------------------
  -- 6. Two tenants keep independent profiles (no cross-talk columns).
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM institutions
    WHERE name = 'PrepGrade Registration Full Probe'
      AND contact_email = 'registrar@example.test';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: profile read-back is not tenant-exact (got %)', n;
  END IF;
  RAISE NOTICE 'PASS: profile data is exact per tenant';
END $$;

ROLLBACK;
