-- ===========================================================================
-- PrepGrade — Classes & Academic Sessions readiness & security harness (prompt 13)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees that
--   CANNOT be proven by unit tests (which run with no database). This file is
--   the ONLY thing that demonstrates 0004 actually holds. It checks:
--     * `status` lifecycle CHECK on classes and academic_sessions (active/archived)
--     * Academic-session uniqueness is the ORIGINAL institution-wide UNIQUE:
--       two live sessions with the same name in one tenant clash (23505)
--     * Classes: live-rows-only partial UNIQUE name index — two live classes
--       clash, archiving frees the name, and RESTORING into a reused name
--       clashes again (the point 4 conflict path)
--     * TENANT-AWARE COMPOSITE FKs now BLOCK a cross-institution class→session
--       and student→class link at the DATABASE (0004 strengthened these from
--       the 0001 single-column FKs that silently allowed them)
--     * `students_update_with_class_history` records the class being LEFT,
--       records NOTHING on an unassigned→assigned move, and returns FALSE for a
--       foreign/deleted student id (the atomic transfer + history write)
--     * `student_class_history` is APPEND-ONLY even for a role that BYPASSES RLS
--       (the update/delete trigger raises regardless of privilege — this is the
--       point-2 finding: RLS cannot protect the service-role connection, so the
--       trigger and the REVOKE do)
--     * Deployed RLS deny-by-default for `anon` (0004)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001, 0002, 0003 then 0004_classes_and_academic_sessions.sql.
--   2. Run this whole file through psql so the transaction is not auto-committed:
--        psql "$DATABASE_URL" -f supabase/tests/classes_readiness.sql
--      or  supabase db query --linked -f supabase/tests/classes_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so no
--   rows persist regardless of pass/fail. The RLS check uses SET LOCAL ROLE to
--   emulate a browser role for a few statements, then resets.
--
-- Output: one `NOTICE` line per check (PASS/FAIL/SKIP). A genuinely broken
-- constraint/trigger does NOT abort — each check traps its own exception and
-- prints FAIL, so you see the whole picture in one run.
-- ===========================================================================

BEGIN;

-- --- 1. Lifecycle CHECK, uniqueness, composite FKs, atomic RPC, append-only --
DO $$
DECLARE
  v_inst_a   uuid;
  v_inst_b   uuid;
  v_sess_a   uuid;
  v_sess_b   uuid;
  v_class_a  uuid;
  v_class_a2 uuid;
  v_class_b  uuid;
  v_student  uuid;
  v_free     uuid;
  v_ok       boolean;
  v_hist     integer;
  v_left     uuid;
BEGIN
  INSERT INTO institutions (name) VALUES ('Class Tenant A') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Class Tenant B') RETURNING id INTO v_inst_b;

  -- (a) session status CHECK: an unknown value must be rejected.
  BEGIN
    INSERT INTO academic_sessions (institution_id, name, status)
      VALUES (v_inst_a, '2025/2026', 'current');
    RAISE NOTICE 'FAIL  session status CHECK: unknown status accepted (should be rejected)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  session status CHECK: unknown status rejected by the constraint';
  END;

  -- Valid active sessions (one per tenant).
  INSERT INTO academic_sessions (institution_id, name, status)
    VALUES (v_inst_a, '2025/2026', 'active') RETURNING id INTO v_sess_a;
  INSERT INTO academic_sessions (institution_id, name, status)
    VALUES (v_inst_b, '2025/2026', 'active') RETURNING id INTO v_sess_b;

  -- (b) ACADEMIC-SESSION UNIQUENESS IS THE ORIGINAL INSTITUTION-WIDE UNIQUE:
  --     a second session with the same name in the SAME tenant must clash.
  BEGIN
    INSERT INTO academic_sessions (institution_id, name, status)
      VALUES (v_inst_a, '2025/2026', 'active');
    RAISE NOTICE 'FAIL  session uniqueness: duplicate active session name accepted (should be rejected)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  session uniqueness: original institution-wide UNIQUE retained (23505)';
  END;

  -- (c) class status CHECK.
  BEGIN
    INSERT INTO classes (institution_id, name, academic_session_id, status)
      VALUES (v_inst_a, 'SS-101', v_sess_a, 'closed');
    RAISE NOTICE 'FAIL  class status CHECK: unknown status accepted (should be rejected)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  class status CHECK: unknown status rejected by the constraint';
  END;

  -- Valid active classes.
  INSERT INTO classes (institution_id, name, academic_session_id, status)
    VALUES (v_inst_a, 'SS-101', v_sess_a, 'active') RETURNING id INTO v_class_a;
  INSERT INTO classes (institution_id, name, academic_session_id, status)
    VALUES (v_inst_a, 'SS-202', v_sess_a, 'active') RETURNING id INTO v_class_a2;
  INSERT INTO classes (institution_id, name, academic_session_id, status)
    VALUES (v_inst_b, 'SS-101', v_sess_b, 'active') RETURNING id INTO v_class_b;

  -- (d) live-name clash in the SAME tenant must be rejected (case-insensitive).
  BEGIN
    INSERT INTO classes (institution_id, name, status)
      VALUES (v_inst_a, 'ss-101', 'active');
    RAISE NOTICE 'FAIL  live-name unique: duplicate active class name accepted (should be rejected)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  live-name unique: duplicate active class name rejected (23505, case-insensitive)';
  END;

  -- (e) COMPOSITE FK class→session: a cross-institution session id is now
  --     BLOCKED BY THE DATABASE (this was the 0001 weakness 0004 closes).
  BEGIN
    INSERT INTO classes (institution_id, name, academic_session_id, status)
      VALUES (v_inst_a, 'Cross Session Link', v_sess_b, 'active');
    RAISE NOTICE 'FAIL  composite FK: cross-tenant class→session link was ACCEPTED (composite FK missing?)';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS  composite FK: cross-tenant class→session link blocked at the database';
  END;

  -- (f) COMPOSITE FK student→class: a cross-institution class id is BLOCKED.
  BEGIN
    INSERT INTO students (institution_id, student_code, full_name, class_id, status)
      VALUES (v_inst_a, 'XOVER-001', 'Cross Tenant Class', v_class_b, 'active');
    RAISE NOTICE 'FAIL  composite FK: cross-tenant student→class link was ACCEPTED (composite FK missing?)';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS  composite FK: cross-tenant student→class link blocked at the database';
  END;

  -- (g) ATOMIC RPC records the class being LEFT (A → A2), not the one arrived at.
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst_a, 'HH-001', 'History Student', v_class_a, 'active') RETURNING id INTO v_student;

  SELECT students_update_with_class_history(
           v_inst_a, v_student, 'History Student', 'HH-001', v_class_a2, 'active'
         ) INTO v_ok;

  IF v_ok THEN
    RAISE NOTICE 'PASS  atomic RPC returned TRUE for a valid transfer';
  ELSE
    RAISE NOTICE 'FAIL  atomic RPC returned FALSE for a valid same-tenant transfer';
  END IF;

  SELECT count(*) INTO v_hist FROM student_class_history
    WHERE institution_id = v_inst_a AND student_id = v_student;
  SELECT class_id INTO v_left FROM student_class_history
    WHERE institution_id = v_inst_a AND student_id = v_student
    ORDER BY changed_at DESC LIMIT 1;

  IF v_hist = 1 AND v_left = v_class_a THEN
    RAISE NOTICE 'PASS  atomic RPC recorded exactly one history row naming the class LEFT';
  ELSE
    RAISE NOTICE 'FAIL  atomic RPC history: expected 1 row naming class %, found % rows naming %',
      v_class_a, v_hist, v_left;
  END IF;

  -- The roster now points at the NEW class (transfer applied atomically).
  IF EXISTS (SELECT 1 FROM students WHERE id = v_student AND class_id = v_class_a2) THEN
    RAISE NOTICE 'PASS  atomic RPC applied the roster update alongside the history row';
  ELSE
    RAISE NOTICE 'FAIL  atomic RPC did not move the student to the new class';
  END IF;

  -- (h) unassigned → assigned records NOTHING (no past class to preserve).
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst_a, 'FREE-001', 'Fresh Student', NULL, 'active') RETURNING id INTO v_free;
  SELECT students_update_with_class_history(
           v_inst_a, v_free, 'Fresh Student', 'FREE-001', v_class_a, 'active'
         ) INTO v_ok;
  SELECT count(*) INTO v_hist FROM student_class_history
    WHERE institution_id = v_inst_a AND student_id = v_free;
  IF v_ok AND v_hist = 0 THEN
    RAISE NOTICE 'PASS  unassigned→assigned move records no history row';
  ELSE
    RAISE NOTICE 'FAIL  unassigned→assigned move expected 0 history rows, found %', v_hist;
  END IF;

  -- (i) RPC fails closed for a foreign id (returns FALSE, writes nothing).
  SELECT students_update_with_class_history(
           v_inst_b, v_student, 'Hijack', 'HH-001', v_class_b, 'active'
         ) INTO v_ok;
  IF v_ok = FALSE THEN
    RAISE NOTICE 'PASS  atomic RPC fails closed (FALSE) for a cross-tenant student id';
  ELSE
    RAISE NOTICE 'FAIL  atomic RPC succeeded for a cross-tenant student id (tenant leak?)';
  END IF;

  -- (j) APPEND-ONLY: UPDATE is refused by the trigger even for this superuser
  --     session (which BYPASSES RLS and GRANT) — the point-2 guarantee.
  BEGIN
    UPDATE student_class_history SET class_name_snapshot = 'tampered'
      WHERE student_id = v_student;
    RAISE NOTICE 'FAIL  append-only: UPDATE on student_class_history was accepted (trigger missing?)';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  append-only: UPDATE on student_class_history blocked by trigger';
  END;

  -- (k) APPEND-ONLY: DELETE is refused too.
  BEGIN
    DELETE FROM student_class_history WHERE student_id = v_student;
    RAISE NOTICE 'FAIL  append-only: DELETE on student_class_history was accepted (trigger missing?)';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  append-only: DELETE on student_class_history blocked by trigger';
  END;

  -- (l) ARCHIVE FREES THE NAME, then RESTORE-INTO-REUSED-NAME CLASHES (point 4).
  UPDATE classes SET status = 'archived' WHERE id = v_class_a;
  BEGIN
    INSERT INTO classes (institution_id, name, academic_session_id, status)
      VALUES (v_inst_a, 'SS-101', v_sess_a, 'active') RETURNING id INTO v_class_a;
    RAISE NOTICE 'PASS  archive frees the name: a new active class reuses it';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'FAIL  archive did NOT free the name (partial index missing?)';
  END;

  -- Now the archived class tries to come back while the NEW live class holds
  -- the name — this must clash (23505), the exact path lib/data/classes.ts
  -- surfaces as { reason: "nameConflict" }.
  BEGIN
    UPDATE classes SET status = 'active'
      WHERE institution_id = v_inst_a AND name = 'SS-101' AND status = 'archived';
    RAISE NOTICE 'FAIL  restore conflict: restoring into a reused name was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  restore conflict: restoring into a reused name is blocked (23505)';
  END;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. RLS deny-by-default for browser roles -------------------------------
-- NOTE: service_role (the data-layer role) BYPASSES RLS by design, which is why
-- append-only is enforced by the trigger above, not by a policy. This section
-- only confirms the browser-facing roles cannot read these tables at all.
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'SKIP  RLS anon test — role "anon" not present (not a Supabase project?)';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['classes', 'academic_sessions', 'student_class_history']
  LOOP
    BEGIN
      EXECUTE 'SET LOCAL ROLE anon';
      BEGIN
        EXECUTE format('SELECT count(*) FROM %I', t);
        RAISE NOTICE 'FAIL  RLS: role anon could SELECT from % (should be denied)', t;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role anon denied SELECT on % (deny-by-default holds)', t;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'SKIP  RLS anon test on % (role switch failed)', t;
    END;
  END LOOP;
END;
$$;

ROLLBACK;

DO $$ BEGIN
  RAISE NOTICE 'SUMMARY: all checks ran inside a rolled-back transaction; no rows persist.';
END $$;
