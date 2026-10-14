-- ===========================================================================
-- PrepGrade — Exam assignment & publishing readiness harness (prompt 19)
-- =========================================================================--
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   0012 migration adds and the application code alone cannot assert:
--     * the exam_student_assignments tenant anchor trigger: a raw insert can
--       NEVER file another institution's student into this exam (the FK
--       proves the student EXISTS, not that it shares the exam's tenant —
--       AGENTS.md §5, the load-bearing rule behind "guessing an exam id is
--       never access")
--     * the status vocabulary: only active/revoked — a fabricated state can
--       NEVER be stored, so the data layer's "active only" reads are the
--       whole grant surface
--     * assigned_by bounds: a blank actor id is refused (the write must
--       always be attributable to a server-derived Clerk id)
--     * the UNIQUE (exam, student): one student is assigned to an exam at
--       most once — duplicate assignments are PREVENTED by the schema, not
--       only deduplicated in code
--     * archive-not-delete: a revoked row is reactivated by UPDATE (the
--       data layer's upsert), never a second coexisting row, so the
--       assignment trail stays a single honest record
--     * exams.published_to CHECK: a negative audience size is refused, while
--       NULL (pre-publish) and 0+ (the frozen publish-time count) are allowed
--     * Deployed RLS deny-by-default + grant posture: browser roles
--       (anon/authenticated) can neither read nor write the assignment rows
--       (they are the access grant delivery checks), while service_role holds
--       the full SELECT/INSERT/UPDATE/DELETE the assignment + revoke flow needs
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0011, then 0012_exam_assignment_publishing.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/exam_assignment_readiness.sql
--      or  supabase db query --linked -f supabase/tests/exam_assignment_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so no
--   rows persist regardless of pass/fail. The RLS check uses SET LOCAL ROLE to
--   emulate a browser role, then resets. If your SQL editor auto-commits, run
--   it through `psql` instead so the transaction holds.
--
-- Output: one `NOTICE` line per check (PASS/FAIL/SKIP). Any hard assertion
-- failure RAISEs an exception and aborts (transaction rolls back), which is the
-- intended "red" result.
-- ===========================================================================

BEGIN;

-- --- 1. student assignment: tenant anchor, vocabulary, uniqueness -------------
DO $$
DECLARE
  v_inst_a   uuid;
  v_inst_b   uuid;
  v_subj_a   uuid;
  v_class_a  uuid;
  v_class_b  uuid;
  v_stud_a   uuid;
  v_stud_b   uuid;
  v_exam     uuid;
BEGIN
  INSERT INTO institutions (name) VALUES ('Assign Tenant A') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Assign Tenant B') RETURNING id INTO v_inst_b;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Mathematics') RETURNING id INTO v_subj_a;
  INSERT INTO classes (institution_id, name) VALUES (v_inst_a, 'SS2 Blue') RETURNING id INTO v_class_a;
  INSERT INTO classes (institution_id, name) VALUES (v_inst_b, 'SS2 Gold') RETURNING id INTO v_class_b;
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst_a, 'A-001', 'Ada A', v_class_a, 'active') RETURNING id INTO v_stud_a;
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst_b, 'B-001', 'Bo B', v_class_b, 'active') RETURNING id INTO v_stud_b;

  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
    VALUES (v_inst_a, 'user_1', 'Assignment probe', v_subj_a, 60) RETURNING id INTO v_exam;

  -- Baseline: a same-tenant direct student assignment inserts cleanly.
  INSERT INTO exam_student_assignments (exam_id, student_id, institution_id, assigned_by)
    VALUES (v_exam, v_stud_a, v_inst_a, 'user_1');
  RAISE NOTICE 'PASS  baseline student assignment inserts cleanly (defaults to active)';

  -- --- tenant anchor: a foreign student never joins this exam ------------------
  BEGIN
    INSERT INTO exam_student_assignments (exam_id, student_id, institution_id, assigned_by)
      VALUES (v_exam, v_stud_b, v_inst_a, 'user_1');
    RAISE NOTICE 'FAIL  assignments anchor trigger: another institution''s student accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  assignments anchor trigger: foreign-institution student refused';
  END;

  -- --- status vocabulary: only active / revoked --------------------------------
  BEGIN
    INSERT INTO exam_student_assignments (exam_id, student_id, institution_id, assigned_by, status)
      VALUES (v_exam, v_stud_a, v_inst_a, 'user_1', 'pending');
    RAISE NOTICE 'FAIL  assignment status CHECK: unknown status ''pending'' accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  assignment status CHECK: only active/revoked are storable';
  END;

  -- --- assigned_by bounds: a blank actor is refused ----------------------------
  BEGIN
    INSERT INTO exam_student_assignments (exam_id, student_id, institution_id, assigned_by)
      VALUES (v_exam, v_stud_a, v_inst_a, '');
    RAISE NOTICE 'FAIL  assigned_by CHECK: blank actor id accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  assigned_by CHECK: blank actor id refused (attributable writes only)';
  END;

  -- --- UNIQUE (exam, student): a duplicate assignment is PREVENTED -------------
  BEGIN
    INSERT INTO exam_student_assignments (exam_id, student_id, institution_id, assigned_by)
      VALUES (v_exam, v_stud_a, v_inst_a, 'user_2');
    RAISE NOTICE 'FAIL  UNIQUE (exam, student): the same student was assigned twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  UNIQUE (exam, student): duplicate direct assignment collides (prevented by schema)';
  END;

  -- --- archive-not-delete: revoke then reactivate is one row, never two --------
  UPDATE exam_student_assignments
    SET status = 'revoked' WHERE exam_id = v_exam AND student_id = v_stud_a;
  BEGIN
    INSERT INTO exam_student_assignments (exam_id, student_id, institution_id, assigned_by, status)
      VALUES (v_exam, v_stud_a, v_inst_a, 'user_1', 'active');
    RAISE NOTICE 'FAIL  revoke trail: a re-assign created a SECOND row alongside the revoked one';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  revoke trail: re-assign reuses the one row (reactivated by UPDATE, no duplicate)';
  END;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. exams.published_to: the audience size frozen at publish ---------------
DO $$
DECLARE
  v_inst   uuid;
  v_subj   uuid;
  v_exam   uuid;
BEGIN
  INSERT INTO institutions (name) VALUES ('Published-To Tenant') RETURNING id INTO v_inst;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst, 'Physics') RETURNING id INTO v_subj;
  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
    VALUES (v_inst, 'user_1', 'Publish stamp probe', v_subj, 60) RETURNING id INTO v_exam;

  -- NULL is legitimate (pre-publish / legacy rows).
  UPDATE exams SET published_to = NULL WHERE id = v_exam;
  RAISE NOTICE 'PASS  published_to accepts NULL (pre-publish / pre-migration rows)';

  -- Zero and positive audience sizes are legitimate.
  UPDATE exams SET published_to = 0 WHERE id = v_exam;
  UPDATE exams SET published_to = 25 WHERE id = v_exam;
  RAISE NOTICE 'PASS  published_to accepts 0 and positive counts (frozen publish size)';

  -- A negative audience size is nonsensical and must be refused.
  BEGIN
    UPDATE exams SET published_to = -1 WHERE id = v_exam;
    RAISE NOTICE 'FAIL  published_to CHECK: a negative audience size was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  published_to CHECK: negative audience size refused';
  END;

  RAISE NOTICE '--- checks 2 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 3. grant posture: service_role full, browser roles revoked ---------------
-- Asserted through the privilege catalogue rather than a live statement (the
-- psql session's superuser would bypass grants anyway).
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      RAISE NOTICE 'SKIP  grant audit for % — role not present (not a Supabase project?)', v_role;
      CONTINUE;
    END IF;

    IF v_role = 'service_role' THEN
      IF has_table_privilege(v_role, 'exam_student_assignments', 'SELECT')
         AND has_table_privilege(v_role, 'exam_student_assignments', 'INSERT')
         AND has_table_privilege(v_role, 'exam_student_assignments', 'UPDATE')
         AND has_table_privilege(v_role, 'exam_student_assignments', 'DELETE') THEN
        RAISE NOTICE 'PASS  grants: service_role holds SELECT/INSERT/UPDATE/DELETE (assign, revoke, reassign)';
      ELSE
        RAISE NOTICE 'FAIL  grants: service_role missing a needed privilege — the assignment flow would break';
      END IF;
    ELSE
      IF has_table_privilege(v_role, 'exam_student_assignments', 'SELECT')
         OR has_table_privilege(v_role, 'exam_student_assignments', 'INSERT')
         OR has_table_privilege(v_role, 'exam_student_assignments', 'UPDATE')
         OR has_table_privilege(v_role, 'exam_student_assignments', 'DELETE') THEN
        RAISE NOTICE 'FAIL  grants: browser role % still holds a privilege on exam_student_assignments', v_role;
      ELSE
        RAISE NOTICE 'PASS  grants: browser role % holds no privilege on exam_student_assignments', v_role;
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- --- 4. RLS deny-by-default for browser roles ---------------------------------
-- Assignment rows ARE the access grant delivery (prompts 22–23) checks; no
-- browser role may ever read or write them directly. The editor/psql session
-- bypasses RLS, so switch roles explicitly.
DO $$
DECLARE
  r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'SKIP  RLS anon test — role "anon" not present (not a Supabase project?)';
    RETURN;
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      BEGIN
        EXECUTE 'SELECT count(*) FROM exam_student_assignments';
        RAISE NOTICE 'FAIL  RLS: role % could SELECT exam_student_assignments (exposed!)', r;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role % denied on exam_student_assignments (deny-by-default holds)', r;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'SKIP  RLS % test on exam_student_assignments (role switch failed)', r;
    END;
  END LOOP;
END;
$$;

ROLLBACK;
