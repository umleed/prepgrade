-- ===========================================================================
-- PrepGrade — Exam attempts readiness harness (prompts 22–23)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   0013 migration adds and the application code alone cannot assert:
--     * the exam_attempts tenant anchor trigger: a raw insert can NEVER tie
--       one institution's student to another institution's exam (the FKs
--       prove existence, not tenancy — AGENTS.md §5, the hole a crafted
--       exam/student id would otherwise open)
--     * the attempt status vocabulary: only in_progress/submitted/expired —
--       `not_started` (the absence of a row) and speculative states like
--       `graded`/`abandoned` can NEVER be stored ahead of the engines that
--       would produce them (prompts 24+), so no read path can half-trust them
--     * attempt_number bounds (1–10): a zero/negative/oversized sitting
--       number is refused by the schema, backing the data layer's
--       max_attempts gate with a hard constraint
--     * UNIQUE (exam, student, attempt_number): the idempotency anchor for
--       concurrent starts — two racing "start" clicks COLLIDE here, and the
--       loser resumes the winner's row instead of creating a parallel attempt
--     * window ordering: expires_at >= started_at — a malformed negative
--       deadline (client or bug) is unstorable, keeping the server-clock
--       timer internally consistent (AGENTS.md §6)
--     * no gradeable columns: a score/correctness column does not exist on
--       either table — grading cannot leak into the delivery layer ahead of
--       prompt 24, so nothing here can be written by, or trusted from, a
--       client
--     * the exam_attempt_answers tenant anchor: an answer can NEVER reference
--       a snapshot from another institution (the shuffle and the key both
--       live in the snapshot; a cross-tenant answer would poison grading)
--     * answer bounds: a negative selected_option_index is refused; NULL is
--       allowed (a review-flag-only row precedes any answer)
--     * UNIQUE (attempt, snapshot) is the PRIMARY KEY — a retried autosave
--       UPSERTs the one row, duplicate answers per question are PREVENTED
--       by the schema, not only deduplicated in code
--     * Deployed RLS deny-by-default + grant posture: browser roles
--       (anon/authenticated) can neither read nor write live attempt rows —
--       these carry in-flight answers and point at key-bearing snapshots;
--       only the server-side service-role client touches them, and it holds
--       exactly SELECT/INSERT/UPDATE (no DELETE — an attempt is never
--       hard-deleted by the app, archive-not-delete, AGENTS.md §6)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0012, then 0013_exam_attempts.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/exam_attempts_readiness.sql
--      or  supabase db query --linked -f supabase/tests/exam_attempts_readiness.sql
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

-- --- 1. exam_attempts: tenant anchor, vocabulary, bounds, idempotency --------
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
  v_now      timestamptz := now();
BEGIN
  INSERT INTO institutions (name) VALUES ('Attempt Tenant A') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Attempt Tenant B') RETURNING id INTO v_inst_b;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Mathematics') RETURNING id INTO v_subj_a;
  INSERT INTO classes (institution_id, name) VALUES (v_inst_a, 'SS2 Blue') RETURNING id INTO v_class_a;
  INSERT INTO classes (institution_id, name) VALUES (v_inst_b, 'SS2 Gold') RETURNING id INTO v_class_b;
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst_a, 'A-001', 'Ada A', v_class_a, 'active') RETURNING id INTO v_stud_a;
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst_b, 'B-001', 'Bo B', v_class_b, 'active') RETURNING id INTO v_stud_b;

  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
    VALUES (v_inst_a, 'user_1', 'Attempt probe', v_subj_a, 60) RETURNING id INTO v_exam;

  -- Baseline: a same-tenant attempt inserts cleanly with server-side defaults.
  INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, started_at, expires_at)
    VALUES (v_exam, v_stud_a, v_inst_a, 1, v_now, v_now + interval '60 minutes');
  RAISE NOTICE 'PASS  baseline attempt inserts cleanly (defaults to in_progress)';

  -- --- tenant anchor: a foreign student never starts this exam ----------------
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, started_at, expires_at)
      VALUES (v_exam, v_stud_b, v_inst_a, 1, v_now, v_now + interval '60 minutes');
    RAISE NOTICE 'FAIL  attempts anchor trigger: another institution''s student accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  attempts anchor trigger: foreign-institution student refused';
  END;

  -- --- status vocabulary: only the three stored states -------------------------
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, status, started_at, expires_at)
      VALUES (v_exam, v_stud_a, v_inst_a, 2, 'not_started', v_now, v_now + interval '60 minutes');
    RAISE NOTICE 'FAIL  attempt status CHECK: unknown status ''not_started'' accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  attempt status CHECK: not_started (absence of a row) is unstorable';
  END;
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, status, started_at, expires_at)
      VALUES (v_exam, v_stud_a, v_inst_a, 2, 'graded', v_now, v_now + interval '60 minutes');
    RAISE NOTICE 'FAIL  attempt status CHECK: premature status ''graded'' accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  attempt status CHECK: graded/abandoned are unstorable until their engines exist';
  END;

  -- --- attempt_number bounds (1–10) -------------------------------------------
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, started_at, expires_at)
      VALUES (v_exam, v_stud_a, v_inst_a, 0, v_now, v_now + interval '60 minutes');
    RAISE NOTICE 'FAIL  attempt_number CHECK: sitting 0 accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  attempt_number CHECK: 0 refused (1–10 range enforced by schema)';
  END;
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, started_at, expires_at)
      VALUES (v_exam, v_stud_a, v_inst_a, 11, v_now, v_now + interval '60 minutes');
    RAISE NOTICE 'FAIL  attempt_number CHECK: sitting 11 accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  attempt_number CHECK: 11 refused (budget can never outrun the frozen max)';
  END;

  -- --- UNIQUE (exam, student, attempt_number): concurrent starts collide -------
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, started_at, expires_at)
      VALUES (v_exam, v_stud_a, v_inst_a, 1, v_now, v_now + interval '60 minutes');
    RAISE NOTICE 'FAIL  UNIQUE (exam, student, attempt_number): a parallel duplicate start was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  UNIQUE (exam, student, attempt_number): race collides — loser resumes winner''s row';
  END;

  -- --- window ordering: expires_at >= started_at -------------------------------
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, started_at, expires_at)
      VALUES (v_exam, v_stud_a, v_inst_a, 3, v_now, v_now - interval '1 minute');
    RAISE NOTICE 'FAIL  window CHECK: a deadline before the start was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  window CHECK: expires_at >= started_at holds the timer consistent';
  END;

  -- --- no gradeable columns: grading cannot leak into delivery ------------------
  IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'exam_attempts'
        AND (column_name ILIKE '%score%' OR column_name ILIKE '%correct%'
             OR column_name ILIKE '%grade%' OR column_name ILIKE '%result%')
  ) THEN
    RAISE NOTICE 'FAIL  exam_attempts carries a score/grading column (prompt 24 leakage)';
  ELSE
    RAISE NOTICE 'PASS  exam_attempts carries no score/correct/grade column (server grading stays isolated)';
  END IF;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. exam_attempt_answers: tenant anchor, bounds, upsert key ---------------
DO $$
DECLARE
  v_inst     uuid;
  v_subj     uuid;
  v_stud     uuid;
  v_class    uuid;
  v_exam     uuid;
  v_attempt  uuid;
  v_q_a      uuid;   -- bank question behind snapshot A
  v_q_a2     uuid;   -- bank question behind snapshot B
  v_q_a3     uuid;   -- bank question behind snapshot C (negative-index probe)
  v_snap_a   uuid;   -- snapshot belonging to v_inst's exam
  v_snap_b   uuid;   -- second own-tenant snapshot (review-flag probe)
  v_snap_c   uuid;   -- third own-tenant snapshot (bounds probe)
  v_now      timestamptz := now();
BEGIN
  INSERT INTO institutions (name) VALUES ('Answer Tenant A') RETURNING id INTO v_inst;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst, 'Physics') RETURNING id INTO v_subj;
  INSERT INTO classes (institution_id, name) VALUES (v_inst, 'SS1 Red') RETURNING id INTO v_class;
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst, 'A-001', 'Ada A', v_class, 'active') RETURNING id INTO v_stud;

  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, status)
    VALUES (v_inst, 'user_1', 'Answer probe', v_subj, 60, 'published') RETURNING id INTO v_exam;

  -- Snapshots freeze real bank questions (FK RESTRICT), so create them first.
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst, 'user_1', 'medium', v_subj,
            'What is 2+2?', '["2","4","6"]'::jsonb, 1) RETURNING id INTO v_q_a;
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst, 'user_1', 'easy', v_subj,
            'Flag me first', '["a","b"]'::jsonb, 0) RETURNING id INTO v_q_a2;

  INSERT INTO exam_question_snapshots
    (exam_id, question_id, institution_id, position, marks, question_type,
     difficulty, subject_id, question_text, options, correct_option_index)
    VALUES (v_exam, v_q_a, v_inst, 1, 5, 'mcq_single', 'medium', v_subj,
            'What is 2+2?', '["2","4","6"]'::jsonb, 1) RETURNING id INTO v_snap_a;

  INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number, started_at, expires_at, question_order)
    VALUES (v_exam, v_stud, v_inst, 1, v_now, v_now + interval '60 minutes', jsonb_build_array(v_snap_a))
    RETURNING id INTO v_attempt;

  -- Baseline: an answer for the attempt's own exam's snapshot inserts cleanly.
  INSERT INTO exam_attempt_answers (attempt_id, snapshot_id, institution_id, selected_option_index)
    VALUES (v_attempt, v_snap_a, v_inst, 1);
  RAISE NOTICE 'PASS  baseline answer inserts cleanly (canonical index stored)';

  -- --- NULL selection allowed: a review-flag-only row precedes any answer ------
  INSERT INTO exam_question_snapshots
    (exam_id, question_id, institution_id, position, marks, question_type,
     difficulty, subject_id, question_text, options, correct_option_index)
    VALUES (v_exam, v_q_a2, v_inst, 2, 5, 'mcq_single', 'easy', v_subj,
            'Flag me first', '["a","b"]'::jsonb, 0) RETURNING id INTO v_snap_b;
  INSERT INTO exam_attempt_answers (attempt_id, snapshot_id, institution_id, selected_option_index, marked_for_review)
    VALUES (v_attempt, v_snap_b, v_inst, NULL, true);
  RAISE NOTICE 'PASS  answer accepts NULL selection (marked-for-review row before answering)';

  -- --- negative canonical index refused (own snapshot, so the PK cannot fire first)
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst, 'user_1', 'easy', v_subj,
            'Negative probe', '["a","b"]'::jsonb, 0) RETURNING id INTO v_q_a3;
  INSERT INTO exam_question_snapshots
    (exam_id, question_id, institution_id, position, marks, question_type,
     difficulty, subject_id, question_text, options, correct_option_index)
    VALUES (v_exam, v_q_a3, v_inst, 3, 2, 'mcq_single', 'easy', v_subj,
            'Negative probe', '["a","b"]'::jsonb, 0) RETURNING id INTO v_snap_c;
  BEGIN
    INSERT INTO exam_attempt_answers (attempt_id, snapshot_id, institution_id, selected_option_index)
      VALUES (v_attempt, v_snap_c, v_inst, -1);
    RAISE NOTICE 'FAIL  selected_option_index CHECK: negative index accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  selected_option_index CHECK: negative index refused';
  END;

  -- --- PRIMARY KEY (attempt, snapshot): a duplicate autosave is PREVENTED -------
  BEGIN
    INSERT INTO exam_attempt_answers (attempt_id, snapshot_id, institution_id, selected_option_index)
      VALUES (v_attempt, v_snap_a, v_inst, 0);
    RAISE NOTICE 'FAIL  PK (attempt, snapshot): the same question was answered twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  PK (attempt, snapshot): retried autosave UPSERTs the one row (no duplicates)';
  END;

  -- --- answers tenant anchor: a foreign snapshot never joins this attempt --------
  -- Build a second institution's question + snapshot and try to answer it
  -- under tenant A.
  DECLARE
    v_inst_b  uuid;
    v_subj_b  uuid;
    v_exam_b  uuid;
    v_q_b     uuid;
    v_snap_b2 uuid;
  BEGIN
    INSERT INTO institutions (name) VALUES ('Answer Tenant B') RETURNING id INTO v_inst_b;
    INSERT INTO subjects (institution_id, name) VALUES (v_inst_b, 'Biology') RETURNING id INTO v_subj_b;
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
      VALUES (v_inst_b, 'user_1', 'Foreign probe', v_subj_b, 30) RETURNING id INTO v_exam_b;
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_b, 'user_2', 'easy', v_subj_b, 'Foreign cell',
              '["x","y"]'::jsonb, 0) RETURNING id INTO v_q_b;
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam_b, v_q_b, v_inst_b, 1, 1, 'mcq_single', 'easy', v_subj_b,
              'Foreign cell', '["x","y"]'::jsonb, 0) RETURNING id INTO v_snap_b2;

    BEGIN
      INSERT INTO exam_attempt_answers (attempt_id, snapshot_id, institution_id, selected_option_index)
        VALUES (v_attempt, v_snap_b2, v_inst, 0);
      RAISE NOTICE 'FAIL  answers anchor trigger: another institution''s snapshot accepted';
    EXCEPTION WHEN raise_exception THEN
      RAISE NOTICE 'PASS  answers anchor trigger: foreign-institution snapshot refused';
    END;
  END;

  -- --- no gradeable columns on the answer row ------------------------------------
  IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'exam_attempt_answers'
        AND (column_name ILIKE '%score%' OR column_name ILIKE '%correct%')
  ) THEN
    RAISE NOTICE 'FAIL  exam_attempt_answers carries a score/correct column (client-trusted grading leakage)';
  ELSE
    RAISE NOTICE 'PASS  exam_attempt_answers carries no score/is_correct column (grading stays server-side)';
  END IF;

  RAISE NOTICE '--- checks 2 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 3. grant posture: service_role write-but-not-delete, browser roles none ----
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
      IF has_table_privilege(v_role, 'exam_attempts', 'SELECT')
         AND has_table_privilege(v_role, 'exam_attempts', 'INSERT')
         AND has_table_privilege(v_role, 'exam_attempts', 'UPDATE')
         AND NOT has_table_privilege(v_role, 'exam_attempts', 'DELETE') THEN
        RAISE NOTICE 'PASS  grants: service_role holds SELECT/INSERT/UPDATE but NOT DELETE on exam_attempts (archive-not-delete)';
      ELSE
        RAISE NOTICE 'FAIL  grants: service_role privilege set on exam_attempts is not the intended SELECT/INSERT/UPDATE-only posture';
      END IF;
      IF has_table_privilege(v_role, 'exam_attempt_answers', 'SELECT')
         AND has_table_privilege(v_role, 'exam_attempt_answers', 'INSERT')
         AND has_table_privilege(v_role, 'exam_attempt_answers', 'UPDATE')
         AND has_table_privilege(v_role, 'exam_attempt_answers', 'DELETE') THEN
        -- DELETE is intentionally granted HERE: the data layer removes a
        -- no-selection/no-flag row when a student un-answers a live question.
        RAISE NOTICE 'PASS  grants: service_role holds the full write set on exam_attempt_answers (autosave + un-answer)';
      ELSE
        RAISE NOTICE 'FAIL  grants: service_role missing a needed privilege on exam_attempt_answers — autosave would break';
      END IF;
    ELSE
      IF has_table_privilege(v_role, 'exam_attempts', 'SELECT')
         OR has_table_privilege(v_role, 'exam_attempts', 'INSERT')
         OR has_table_privilege(v_role, 'exam_attempts', 'UPDATE')
         OR has_table_privilege(v_role, 'exam_attempts', 'DELETE') THEN
        RAISE NOTICE 'FAIL  grants: browser role % still holds a privilege on exam_attempts (exposed!)', v_role;
      ELSE
        RAISE NOTICE 'PASS  grants: browser role % holds no privilege on exam_attempts', v_role;
      END IF;
      IF has_table_privilege(v_role, 'exam_attempt_answers', 'SELECT')
         OR has_table_privilege(v_role, 'exam_attempt_answers', 'INSERT')
         OR has_table_privilege(v_role, 'exam_attempt_answers', 'UPDATE')
         OR has_table_privilege(v_role, 'exam_attempt_answers', 'DELETE') THEN
        RAISE NOTICE 'FAIL  grants: browser role % still holds a privilege on exam_attempt_answers (exposed!)', v_role;
      ELSE
        RAISE NOTICE 'PASS  grants: browser role % holds no privilege on exam_attempt_answers', v_role;
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- --- 4. RLS deny-by-default for browser roles -----------------------------------
-- Live attempts carry in-flight answers and key-bearing snapshot references;
-- no browser role may ever read or write them directly — the server-side
-- service-role client behind ownership filters is the only path (AGENTS.md §5–6).
-- The editor/psql session bypasses RLS, so switch roles explicitly.
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
        EXECUTE 'SELECT count(*) FROM exam_attempts';
        RAISE NOTICE 'FAIL  RLS: role % could SELECT exam_attempts (exposed!)', r;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role % denied on exam_attempts (deny-by-default holds)', r;
      END;
      BEGIN
        EXECUTE 'SELECT count(*) FROM exam_attempt_answers';
        RAISE NOTICE 'FAIL  RLS: role % could SELECT exam_attempt_answers (exposed!)', r;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role % denied on exam_attempt_answers (deny-by-default holds)', r;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'SKIP  RLS % test on attempt tables (role switch failed)', r;
    END;
  END LOOP;
END;
$$;

ROLLBACK;
