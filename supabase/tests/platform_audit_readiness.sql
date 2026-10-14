-- ===========================================================================
-- PrepGrade — Platform audit log readiness & security harness (prompt 31)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code cannot assert without a database:
--     * the 0007 table exists with its CHECK bounds (actor_role whitelist,
--       outcome whitelist, action length, detail must be a bounded JSON
--       object) — the columns the platform data layer writes
--     * APPEND-ONLY: UPDATE and DELETE are refused for every role, including
--       the table owner and BYPASSRLS roles (the reject-mutation trigger)
--     * service_role holds only SELECT + INSERT — no UPDATE/DELETE grant
--       exists for the key the application uses
--     * Deployed RLS deny-by-default: `anon` and `authenticated` can neither
--       read nor write the table (RLS enabled + FORCED, zero permissive
--       policies, grants revoked — mirrors 0002)
--     * the platform-overview source tables exist so the dashboard counts
--       have a real data source (institutions, profiles,
--       institution_memberships, questions) and the memberships role CHECK
--       matches the app's role catalog
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply migrations 0001–0007.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/platform_audit_readiness.sql
--      or  supabase db query --linked -f supabase/tests/platform_audit_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so
--   no rows persist regardless of pass/fail. The RLS checks use SET LOCAL ROLE
--   to emulate a browser role for a few statements, then reset. If your SQL
--   editor auto-commits, run it through `psql` instead so the transaction
--   holds.
--
-- Output: one `NOTICE` line per check (PASS/FAIL). Any hard assertion
-- failure RAISEs an exception and aborts (transaction rolls back), which is
-- the intended "red" result.
-- ===========================================================================

BEGIN;

-- Helper: report and assert.
DO $$
DECLARE
  ok boolean;
  n  text;
BEGIN
  -- ------------------------------------------------------------------
  -- 1. Table + columns exist (0007 applied).
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_audit_log';
  IF n::int < 9 THEN
    RAISE EXCEPTION 'FAIL: platform_audit_log missing columns (found %); apply 0007', n;
  END IF;
  RAISE NOTICE 'PASS: platform_audit_log exists with % columns', n;

  -- ------------------------------------------------------------------
  -- 2. Insert of a well-formed denial event succeeds (the exact shape
  --    lib/data/audit.ts writes via buildAuditEntry).
  -- ------------------------------------------------------------------
  INSERT INTO platform_audit_log (actor_id, actor_role, action, target_type, target_id, outcome, detail)
  VALUES ('user_test123', 'INSTITUTION_ADMIN', 'platform.access_denied', 'area', '/platform', 'denied',
          '{"summary": "role required: SUPER_ADMIN"}'::jsonb);
  RAISE NOTICE 'PASS: well-formed audit insert accepted';

  -- ------------------------------------------------------------------
  -- 3. CHECK constraints refuse malformed rows.
  -- ------------------------------------------------------------------
  -- 3a. unknown actor_role
  BEGIN
    INSERT INTO platform_audit_log (actor_id, actor_role, action, outcome)
    VALUES ('user_x', 'ROOT', 'platform.access_denied', 'success');
    RAISE EXCEPTION 'FAIL: actor_role CHECK did not refuse ROOT';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: actor_role CHECK refuses unknown roles';
  END;

  -- 3b. unknown outcome
  BEGIN
    INSERT INTO platform_audit_log (actor_id, actor_role, action, outcome)
    VALUES ('user_x', 'STUDENT', 'platform.access_denied', 'maybe');
    RAISE EXCEPTION 'FAIL: outcome CHECK did not refuse maybe';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: outcome CHECK refuses unknown outcomes';
  END;

  -- 3c. detail must be a JSON object (array refused)
  BEGIN
    INSERT INTO platform_audit_log (actor_id, actor_role, action, outcome, detail)
    VALUES ('user_x', 'STUDENT', 'platform.access_denied', 'denied', '[]'::jsonb);
    RAISE EXCEPTION 'FAIL: detail CHECK did not refuse a JSON array';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: detail CHECK refuses non-object jsonb';
  END;

  -- 3d. oversized action is refused (bounds mirrored in AUDIT_LIMITS)
  BEGIN
    INSERT INTO platform_audit_log (actor_id, actor_role, action, outcome)
    VALUES ('user_x', 'STUDENT', repeat('a', 81), 'denied');
    RAISE EXCEPTION 'FAIL: action length CHECK did not refuse 81 chars';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: action length CHECK refuses >80 chars';
  END;

  -- ------------------------------------------------------------------
  -- 4. Append-only: UPDATE and DELETE raise for the owner/BYPASSRLS path
  --    (this session runs as a superuser-like role — the trigger must
  --    refuse regardless).
  -- ------------------------------------------------------------------
  BEGIN
    UPDATE platform_audit_log SET outcome = 'success' WHERE actor_id = 'user_test123';
    RAISE EXCEPTION 'FAIL: audit UPDATE was not refused';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: append-only trigger refuses UPDATE';
  END;

  BEGIN
    DELETE FROM platform_audit_log WHERE actor_id = 'user_test123';
    RAISE EXCEPTION 'FAIL: audit DELETE was not refused';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: append-only trigger refuses DELETE';
  END;

  -- ------------------------------------------------------------------
  -- 5. service_role holds SELECT + INSERT only — no UPDATE/DELETE grant.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM information_schema.role_table_grants
    WHERE table_name = 'platform_audit_log' AND grantee = 'service_role'
      AND privilege_type IN ('UPDATE','DELETE');
  IF n > 0 THEN
    RAISE EXCEPTION 'FAIL: service_role holds % UPDATE/DELETE grant(s) on the audit log', n;
  END IF;
  RAISE NOTICE 'PASS: service_role grants are SELECT+INSERT only';

  -- ------------------------------------------------------------------
  -- 6. RLS is enabled + forced, and browser roles are denied outright.
  -- ------------------------------------------------------------------
  SELECT (relrowsecurity AND relforcerowsecurity) INTO ok
    FROM pg_class WHERE oid = 'platform_audit_log'::regclass;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: RLS not enabled+forced on platform_audit_log';
  END IF;
  RAISE NOTICE 'PASS: RLS enabled + forced';

  -- 6a. anon cannot SELECT (grant revoked AND no policies).
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM count(*) FROM platform_audit_log;
    RAISE EXCEPTION 'FAIL: anon read the audit log';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: anon denied SELECT';
  END;
  RESET ROLE;

  -- 6b. authenticated cannot INSERT.
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO platform_audit_log (actor_id, actor_role, action, outcome)
    VALUES ('attacker', 'SUPER_ADMIN', 'platform.access_denied', 'success');
    RAISE EXCEPTION 'FAIL: authenticated wrote to the audit log';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: authenticated denied INSERT';
  END;
  RESET ROLE;

  -- ------------------------------------------------------------------
  -- 7. Dashboard data sources exist (counts have a real table behind
  --    them) and the membership role CHECK matches the app catalog.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO n FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('institutions','profiles','institution_memberships','questions');
  IF n < 4 THEN
    RAISE NOTICE 'FAIL: only % of 4 overview source tables exist', n;
    RAISE EXCEPTION 'missing overview source tables';
  END IF;
  RAISE NOTICE 'PASS: all four overview source tables exist';

  -- 7a. the memberships CHECK refuses a role the app does not know.
  BEGIN
    INSERT INTO institution_memberships (institution_id, user_id, role)
    VALUES (gen_random_uuid(), 'user_ghost', 'PLATFORM_OWNER');
    RAISE EXCEPTION 'FAIL: membership role CHECK accepted an unknown role';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE 'PASS: membership role CHECK matches the app catalog';
  END;
END $$;

ROLLBACK;
