-- ===========================================================================
-- PrepGrade — Platform usage time-series readiness harness (0018)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   /platform/usage screen relies on and the app layer cannot assert alone:
--     * the platform_usage_time_series function exists, is STABLE, and has
--       the exact (source, bucket_start, event_count) output shape
--     * EXECUTE is granted to service_role ONLY — anon/authenticated are
--       refused (the cross-tenant aggregate must never be browser-reachable)
--     * invalid granularity and an inverted window FAIL CLOSED (error, not
--       a quietly wrong chart)
--     * buckets are UTC-pinned: with the session time zone set to
--       America/Los_Angeles, an event at 02:00 UTC lands in the UTC day
--       bucket, never the local (previous) day
--     * p_institution_id filters tenant-owned sources (institutions,
--       questions) and yields NO accounts rows — profiles has no tenant
--       column, matching the app's "series dropped, not borrowed" rule
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply migrations 0001–0018.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/platform_usage_readiness.sql
--      or  supabase db query --linked -f supabase/tests/platform_usage_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so
--   no fixture rows persist regardless of pass/fail. The anon-execution check
--   uses SET LOCAL ROLE and resets before finishing.
--
-- Output: one `NOTICE` line per check (PASS/FAIL). Any hard assertion
-- failure RAISEs an exception and aborts (transaction rolls back), which is
-- the intended "red" result.
-- ===========================================================================

BEGIN;

SET LOCAL TIME ZONE 'America/Los_Angeles';  -- prove UTC pinning deliberately

-- ---------------------------------------------------------------------------
-- 1. Function exists with the expected shape and volatility.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  p   pg_proc%ROWTYPE;
  n   int;
BEGIN
  SELECT * INTO p FROM pg_proc
    WHERE proname = 'platform_usage_time_series';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: platform_usage_time_series missing; apply 0018';
  END IF;
  IF p.provolatile <> 's' THEN
    RAISE EXCEPTION 'FAIL: usage function must be STABLE (got %)', p.provolatile;
  END IF;
  SELECT count(*) INTO n FROM pg_attribute
    WHERE attrelid = p.oid AND attnum > 0 AND NOT attisdropped;
  IF n <> 3 THEN
    RAISE EXCEPTION 'FAIL: expected 3 OUT columns, found %', n;
  END IF;
  RAISE NOTICE 'PASS: platform_usage_time_series exists, STABLE, 3 output columns';
END $$;

-- ---------------------------------------------------------------------------
-- 2. Grants: service_role executes; browser roles do not.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text := 'platform_usage_time_series(timestamptz, timestamptz, text, uuid)';
BEGIN
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role lacks EXECUTE on the usage function';
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute the usage function (cross-tenant leak)';
  END IF;
  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated can execute the usage function';
  END IF;
  RAISE NOTICE 'PASS: EXECUTE is service_role-only (anon/authenticated refused)';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Fail-closed input validation.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM * FROM platform_usage_time_series(
      '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'hour', NULL);
    RAISE EXCEPTION 'FAIL: invalid granularity was accepted';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RAISE NOTICE 'PASS: unknown granularity refused with 22023';
  END;

  BEGIN
    PERFORM * FROM platform_usage_time_series(
      '2026-01-05 00:00+00', '2026-01-03 00:00+00', 'day', NULL);
    RAISE EXCEPTION 'FAIL: inverted window was accepted';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RAISE NOTICE 'PASS: inverted window refused with 22023';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Seed fixtures (rolled back with the whole transaction).
--    Windows: [2026-01-01, 2026-01-03) UTC. A is created at 02:00 UTC on the
--    1st — 18:00 LOCAL on Dec 31 in the session timezone, so a local-time
--    bug would move it out of the window's first bucket entirely.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  a_id uuid := '00000000-0000-4000-8000-0000000000a1';
  b_id uuid := '00000000-0000-4000-8000-0000000000b2';
  s_id uuid;
BEGIN
  INSERT INTO institutions (id, name, created_at) VALUES
    (a_id, 'Usage Harness Alpha School', '2026-01-01 02:00:00+00'),
    (b_id, 'Usage Harness Beta Tutorial', '2026-01-02 00:10:00+00');

  INSERT INTO profiles (id, email, is_active, created_at) VALUES
    ('usage-harness-user-1', 'harness1@example.invalid', true,
     '2026-01-01 02:30:00+00');

  INSERT INTO subjects (id, institution_id, name)
    VALUES (gen_random_uuid(), b_id, 'Harness Subject') RETURNING id INTO s_id;

  INSERT INTO questions (
    institution_id, created_by, difficulty, subject_id,
    question_text, options, correct_option_index, created_at
  ) VALUES (
    b_id, 'usage-harness-user-1', 'easy', s_id,
    'Which bucket does this row land in?',
    '["January 2", "January 3"]'::jsonb, 0,
    '2026-01-02 01:00:00+00'
  );

  RAISE NOTICE 'PASS: fixtures seeded (2 institutions, 1 profile, 1 question)';
END $$;

-- ---------------------------------------------------------------------------
-- 5. UTC-pinned day bucketing, platform-wide.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n        bigint;
  day_key  date;
BEGIN
  SELECT bucket_start, event_count INTO day_key, n
    FROM platform_usage_time_series(
      '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day', NULL)
    WHERE source = 'institutions' AND bucket_start = '2026-01-01';
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL: UTC 02:00 event not in 2026-01-01 bucket (count %); bucketing leaked into local time', n;
  END IF;
  RAISE NOTICE 'PASS: institutions bucket by UTC day despite a Los_Angeles session';

  SELECT count(*) INTO n FROM platform_usage_time_series(
      '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day', NULL)
    WHERE source = 'institutions' AND bucket_start = '2025-12-31';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a Dec-31 bucket appeared — bucketing is local, not UTC';
  END IF;

  SELECT event_count INTO n FROM platform_usage_time_series(
      '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day', NULL)
    WHERE source = 'accounts' AND bucket_start = '2026-01-01';
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL: accounts day bucket wrong (got %)', n;
  END IF;
  RAISE NOTICE 'PASS: accounts series counts profile registrations per UTC day';
END $$;

-- ---------------------------------------------------------------------------
-- 6. Institution filter: narrows tenant-owned sources; NEVER fabricates an
--    accounts attribution (profiles has no tenant column → no rows).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  b_id uuid := '00000000-0000-4000-8000-0000000000b2';
  n    bigint;
BEGIN
  SELECT coalesce(sum(event_count), 0) INTO n FROM platform_usage_time_series(
    '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day', b_id)
    WHERE source = 'institutions';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: institution-filtered institutions series summed to % (expected 1)', n;
  END IF;

  SELECT coalesce(sum(event_count), 0) INTO n FROM platform_usage_time_series(
    '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day', b_id)
    WHERE source = 'questions';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: institution-filtered questions series summed to % (expected 1)', n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM platform_usage_time_series(
      '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day', b_id)
      WHERE source = 'accounts'
  ) THEN
    RAISE EXCEPTION 'FAIL: accounts series leaked rows under an institution filter';
  END IF;
  RAISE NOTICE 'PASS: institution filter narrows tenant-owned sources and drops accounts';

  -- Questions created under the OTHER institution must not appear.
  SELECT coalesce(sum(event_count), 0) INTO n FROM platform_usage_time_series(
    '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day',
    '00000000-0000-4000-8000-0000000000a1')
    WHERE source = 'questions';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: cross-tenant question rows appeared (% )', n;
  END IF;
  RAISE NOTICE 'PASS: tenant isolation — no other institution''s rows in a filtered series';
END $$;

-- ---------------------------------------------------------------------------
-- 7. Browser role truly refused at execution time (not just by the grant
--    catalog). Runs last; RESET ROLE before finishing.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM * FROM platform_usage_time_series(
      '2026-01-01 00:00+00', '2026-01-03 00:00+00', 'day', NULL);
    RESET ROLE;
    RAISE EXCEPTION 'FAIL: anon executed the usage function';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE 'PASS: anon execution refused at runtime (insufficient_privilege)';
  END;
END $$;

ROLLBACK;
