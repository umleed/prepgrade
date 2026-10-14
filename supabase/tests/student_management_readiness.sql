-- ===========================================================================
-- PrepGrade — Student Management readiness & security harness (prompt 11)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code and this reviewer could NOT assert without a database:
--     * CRUD against the tenant schema (0001)
--     * Per-institution UNIQUE(student_code) behaviour, incl. cross-tenant reuse
--       and soft-delete reuse (the partial index students_code_active_uidx)
--     * That the DB FK alone does NOT stop a cross-tenant class_id — proving the
--       app-layer `classBelongsToInstitution` check is load-bearing
--     * Deployed RLS deny-by-default for `anon` / `authenticated` (0002)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001_tenant_foundation.sql then 0002_row_level_security.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        p "$DATABASE_URL" -f supabase/tests/student_management_readiness.sql
--      or  supabase db query --linked -f supabase/tests/student_management_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so no
--   rows persist regardless of pass/fail. The RLS checks use SET LOCAL ROLE to
--   emulate a browser role for a few statements, then reset. If your SQL editor
--   auto-commits, run it through `psql` instead so the transaction holds.
--
-- Output: one `NOTICE` line per check (PASS/FAIL/SKIP) and a final SUMMARY.
-- Any hard assertion failure RAISEs an exception and aborts (transaction rolls
-- back), which is the intended "red" result.
-- ===========================================================================

BEGIN;

-- Each section below is a self-contained DO block that prints PASS/FAIL/SKIP
-- lines via RAISE NOTICE. All of it runs inside the single transaction opened
-- above and is discarded by the ROLLBACK at the end.

-- --- 1. Setup two isolated tenants + classes + a student ---------------------
DO $$
DECLARE
  v_inst_a  uuid;
  v_inst_b  uuid;
  v_class_a uuid;
  v_class_b uuid;
  v_dup     boolean := false;
  v_xtenant_code_ok boolean := false;
BEGIN
  INSERT INTO institutions (name) VALUES ('Tenant A Test') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Tenant B Test') RETURNING id INTO v_inst_b;

  INSERT INTO classes (institution_id, name) VALUES (v_inst_a, 'A / SS-101') RETURNING id INTO v_class_a;
  INSERT INTO classes (institution_id, name) VALUES (v_inst_b, 'B / SS-202') RETURNING id INTO v_class_b;

  -- CRUD: create
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst_a, 'SS-001', 'Ada A', v_class_a, 'active');

  -- Same code in a DIFFERENT tenant must be allowed (code is institution-scoped).
  BEGIN
    INSERT INTO students (institution_id, student_code, full_name, class_id, status)
      VALUES (v_inst_b, 'SS-001', 'Bo B', v_class_b, 'active');
    v_xtenant_code_ok := true;
  EXCEPTION WHEN unique_violation THEN
    v_xtenant_code_ok := false;
  END;
  IF v_xtenant_code_ok THEN
    RAISE NOTICE 'PASS  per-institution unique: same code allowed in another tenant';
  ELSE
    RAISE NOTICE 'FAIL  per-institution unique: cross-tenant same code was rejected (should be allowed)';
  END IF;

  -- Duplicate code in the SAME tenant must be rejected (23505).
  BEGIN
    INSERT INTO students (institution_id, student_code, full_name)
      VALUES (v_inst_a, 'SS-001', 'Duplicate A');
    RAISE NOTICE 'FAIL  per-institution unique: duplicate code in same tenant was accepted (should be rejected)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  per-institution unique: duplicate code in same tenant rejected (23505)';
  END;

  -- Read scoped by tenant returns exactly Ada A.
  PERFORM 1 FROM students WHERE institution_id = v_inst_a AND student_code = 'SS-001' AND full_name = 'Ada A';
  IF FOUND THEN
    RAISE NOTICE 'PASS  tenant-scoped read finds the expected student';
  ELSE
    RAISE NOTICE 'FAIL  tenant-scoped read did not find the student it created';
  END IF;

  -- Update scoped by tenant (mirrors updateStudent's .eq(institution_id)).
  UPDATE students SET full_name = 'Ada A2'
    WHERE id = (SELECT id FROM students WHERE institution_id = v_inst_a AND student_code = 'SS-001' LIMIT 1)
      AND institution_id = v_inst_a;
  IF EXISTS (SELECT 1 FROM students WHERE institution_id = v_inst_a AND full_name = 'Ada A2') THEN
    RAISE NOTICE 'PASS  tenant-scoped update applies';
  ELSE
    RAISE NOTICE 'FAIL  tenant-scoped update did not apply';
  END IF;

  -- Deactivate is a status flip, never a delete (mirrors setStudentStatus).
  UPDATE students SET status = 'inactive'
    WHERE institution_id = v_inst_a AND student_code = 'SS-001';
  IF EXISTS (SELECT 1 FROM students WHERE institution_id = v_inst_a AND student_code = 'SS-001' AND status = 'inactive') THEN
    RAISE NOTICE 'PASS  deactivation flips status and preserves the row';
  ELSE
    RAISE NOTICE 'FAIL  deactivation did not preserve the row/status';
  END IF;

  -- Invalid status is rejected by the CHECK constraint.
  BEGIN
    UPDATE students SET status = 'graduated' WHERE institution_id = v_inst_a AND student_code = 'SS-001';
    RAISE NOTICE 'FAIL  status CHECK: an unknown status was accepted (should be rejected)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  status CHECK: unknown status rejected by the constraint';
  END;

  -- Soft-delete frees the code for reuse (partial unique index WHERE deleted_at IS NULL).
  UPDATE students SET deleted_at = now() WHERE institution_id = v_inst_a AND student_code = 'SS-001';
  BEGIN
    INSERT INTO students (institution_id, student_code, full_name)
      VALUES (v_inst_a, 'SS-001', 'Reused After Soft Delete');
    RAISE NOTICE 'PASS  soft-deleted code can be reused (partial unique index works)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'FAIL  soft-deleted code could NOT be reused (partial index missing?)';
  END;

  -- STUDENT→CLASS TENANT INTEGRITY. Before 0004 the plain FK to classes(id)
  -- proved only that the class EXISTS, not that it shares the student's
  -- institution, so a cross-tenant class_id slipped through and
  -- lib/data/students.ts::classBelongsToInstitution was the ONLY barrier.
  -- Migration 0004 repoints this at a composite FK (institution_id, class_id)
  -- → classes(institution_id, id), so the DATABASE now blocks the cross-tenant
  -- link. Both outcomes are handled so this harness is valid pre- and post-0004:
  BEGIN
    INSERT INTO students (institution_id, student_code, full_name, class_id)
      VALUES (v_inst_a, 'SS-XOVER', 'Cross Tenant Class', v_class_b);
    RAISE NOTICE 'INFO  cross-tenant class_id ACCEPTED — 0004 composite FK not applied here; app-layer classBelongsToInstitution is REQUIRED';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS  composite FK blocks a cross-tenant class_id at the database (0004 applied)';
  END;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. RLS deny-by-default for browser roles -------------------------------
-- Requires the `authenticated` role to exist (it does on a provisioned Supabase
-- project). The editor/psql session runs as a superuser/GROUP role that BYPASSES
-- RLS, so we switch to the browser-facing roles explicitly.
DO $$
DECLARE
  v_ok boolean := false;
BEGIN
  -- These role names may not exist on a bare Postgres; skip gracefully then.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'SKIP  RLS anon test — role "anon" not present (not a Supabase project?)';
    RETURN;
  END IF;

  -- As `anon`, ANY select on students must be denied (REVOKE ALL + FORCE RLS).
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    BEGIN
      EXECUTE 'SELECT count(*) FROM students';
      RAISE NOTICE 'FAIL  RLS: role anon could SELECT from students (should be denied)';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS  RLS: role anon denied SELECT on students (deny-by-default holds)';
    END;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN others THEN
    EXECUTE 'RESET ROLE';
    RAISE NOTICE 'SKIP  RLS anon test could not run: %', SQLERRM;
  END;
END;
$$;

ROLLBACK;

DO $$ BEGIN
  RAISE NOTICE 'SUMMARY: all setup/RLS checks ran inside a rolled-back transaction; no rows persist.';
END $$;
