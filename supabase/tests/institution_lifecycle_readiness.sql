-- ===========================================================================
-- PrepGrade — Institution lifecycle readiness harness (prompt 32)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code cannot assert without a database (migration 0008):
--     * institutions has the `status` and `institution_type` columns
--     * `status` is NOT NULL with an 'active' default and its CHECK refuses
--       any value outside ('active','suspended','archived') — the exact set
--       lib/institutions.ts treats as approved
--     * `institution_type` is nullable and its CHECK refuses a value outside
--       ('school','tutorial_centre','cbt_centre'), while accepting NULL
--       (an unset type must render "Not set", never be guessed)
--     * a newly inserted institution with no explicit status reads back as
--       'active' (so pre-existing and fresh rows behave identically)
--     * an approved status transition is a plain UPDATE the schema permits
--     * the status index exists (support filtering stays cheap)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply migrations 0001–0008.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/institution_lifecycle_readiness.sql
--      or  supabase db query --linked -f supabase/tests/institution_lifecycle_readiness.sql
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
BEGIN
  -- ------------------------------------------------------------------
  -- 1. Columns exist (0008 applied).
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'institutions'
      AND column_name IN ('status','institution_type');
  IF n < 2 THEN
    RAISE EXCEPTION 'FAIL: institutions missing lifecycle column(s) (found % of 2); apply 0008', n;
  END IF;
  RAISE NOTICE 'PASS: institutions has status + institution_type columns';

  -- ------------------------------------------------------------------
  -- 2. status is NOT NULL with an 'active' default.
  -- ------------------------------------------------------------------
  SELECT (NOT is_nullable::boolean) AND (column_default = '''active''::text')
    INTO ok
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'institutions'
      AND column_name = 'status';
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: institutions.status is not NOT NULL with an ''active'' default';
  END IF;
  RAISE NOTICE 'PASS: institutions.status is NOT NULL, defaults to active';

  -- ------------------------------------------------------------------
  -- 3. A fresh institution with no explicit status reads back 'active'.
  -- ------------------------------------------------------------------
  INSERT INTO institutions (name) VALUES ('PrepGrade Lifecycle Probe');
  SELECT status INTO v FROM institutions WHERE name = 'PrepGrade Lifecycle Probe';
  IF v <> 'active' THEN
    RAISE EXCEPTION 'FAIL: new institution status defaulted to % (expected active)', v;
  END IF;
  RAISE NOTICE 'PASS: newly created institution defaults to active';

  -- ------------------------------------------------------------------
  -- 4. status CHECK refuses a value outside the approved set.
  -- ------------------------------------------------------------------
  BEGIN
    UPDATE institutions SET status = 'deleted' WHERE name = 'PrepGrade Lifecycle Probe';
    RAISE EXCEPTION 'FAIL: status CHECK did not refuse ''deleted''';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: status CHECK refuses unknown statuses';
  END;

  -- ------------------------------------------------------------------
  -- 5. Approved transitions are plain, permitted UPDATEs.
  -- ------------------------------------------------------------------
  UPDATE institutions SET status = 'suspended' WHERE name = 'PrepGrade Lifecycle Probe';
  SELECT status INTO v FROM institutions WHERE name = 'PrepGrade Lifecycle Probe';
  IF v <> 'suspended' THEN
    RAISE EXCEPTION 'FAIL: active→suspended update did not persist (% )', v;
  END IF;
  UPDATE institutions SET status = 'archived' WHERE name = 'PrepGrade Lifecycle Probe';
  SELECT status INTO v FROM institutions WHERE name = 'PrepGrade Lifecycle Probe';
  IF v <> 'archived' THEN
    RAISE EXCEPTION 'FAIL: suspended→archived update did not persist';
  END IF;
  RAISE NOTICE 'PASS: approved status transitions persist';

  -- ------------------------------------------------------------------
  -- 6. institution_type accepts NULL and valid values; refuses invalid.
  -- ------------------------------------------------------------------
  UPDATE institutions SET institution_type = 'school' WHERE name = 'PrepGrade Lifecycle Probe';
  SELECT institution_type INTO v FROM institutions WHERE name = 'PrepGrade Lifecycle Probe';
  IF v <> 'school' THEN
    RAISE EXCEPTION 'FAIL: institution_type did not accept a valid value';
  END IF;
  UPDATE institutions SET institution_type = NULL WHERE name = 'PrepGrade Lifecycle Probe';
  SELECT institution_type INTO v FROM institutions WHERE name = 'PrepGrade Lifecycle Probe';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: institution_type did not accept NULL';
  END IF;
  RAISE NOTICE 'PASS: institution_type accepts valid value and NULL';

  BEGIN
    UPDATE institutions SET institution_type = 'kindergarten'
      WHERE name = 'PrepGrade Lifecycle Probe';
    RAISE EXCEPTION 'FAIL: institution_type CHECK did not refuse ''kindergarten''';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: institution_type CHECK refuses unknown types';
  END;

  -- ------------------------------------------------------------------
  -- 7. The status index exists.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'institutions'
      AND indexname = 'institutions_status_idx';
  IF n < 1 THEN
    RAISE EXCEPTION 'FAIL: institutions_status_idx is missing';
  END IF;
  RAISE NOTICE 'PASS: institutions_status_idx exists';
END $$;

-- ===========================================================================
-- Institution DETAIL DASHBOARD tenant-scoping (prompt 32 detail view)
-- ===========================================================================
-- The detail dashboard reads, for ONE institution: membership head-counts
-- bucketed by role, class counts, and platform-audit activity attributed via
-- target_type/target_id. Every one of those reads is scoped server-side by the
-- trusted institution id (the data layer's `.eq("institution_id", …)` and the
-- audit target pair). Because the app uses the service-role client (which
-- BYPASSES RLS), that scoping is the ONLY isolation boundary — so this block
-- proves, against a real database, that a scoped count for institution A never
-- leaks rows belonging to institution B.

DO $$
DECLARE
  inst_a  uuid;
  inst_b  uuid;
  n       int;
BEGIN
  -- Two tenants, each with its own members and classes.
  INSERT INTO institutions (name) VALUES ('PrepGrade Scope A') RETURNING id INTO inst_a;
  INSERT INTO institutions (name) VALUES ('PrepGrade Scope B') RETURNING id INTO inst_b;

  INSERT INTO profiles (id, email) VALUES
    ('scope_a_teacher', 'a-t@example.test'),
    ('scope_a_student', 'a-s@example.test'),
    ('scope_b_teacher', 'b-t@example.test');

  INSERT INTO institution_memberships (institution_id, user_id, role) VALUES
    (inst_a, 'scope_a_teacher', 'TEACHER'),
    (inst_a, 'scope_a_student', 'STUDENT'),
    (inst_b, 'scope_b_teacher', 'TEACHER');

  INSERT INTO classes (institution_id, name) VALUES
    (inst_a, 'A-JSS1'),
    (inst_a, 'A-JSS2'),
    (inst_b, 'B-SS3');

  -- 1. Membership count for A is exactly its own two, not B's.
  SELECT count(*) INTO n FROM institution_memberships WHERE institution_id = inst_a;
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: institution A membership count leaked (got %, expected 2)', n;
  END IF;
  RAISE NOTICE 'PASS: membership head-count is tenant-scoped';

  -- 2. Class count for A is exactly its own two.
  SELECT count(*) INTO n FROM classes WHERE institution_id = inst_a;
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL: institution A class count leaked (got %, expected 2)', n;
  END IF;
  RAISE NOTICE 'PASS: class count is tenant-scoped';

  -- 3. Audit activity attributed to A (target_type/target_id pair) excludes B.
  INSERT INTO platform_audit_log (actor_id, actor_role, action, target_type, target_id, outcome)
    VALUES
      ('ops_1', 'SUPER_ADMIN', 'institution.status_changed', 'institution', inst_a::text, 'success'),
      ('ops_1', 'SUPER_ADMIN', 'institution.status_changed', 'institution', inst_b::text, 'success');

  SELECT count(*) INTO n FROM platform_audit_log
    WHERE target_type = 'institution' AND target_id = inst_a::text;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: audit activity for A is not isolated (got %, expected 1)', n;
  END IF;
  RAISE NOTICE 'PASS: audit activity scoping isolates one institution';
END $$;

ROLLBACK;
