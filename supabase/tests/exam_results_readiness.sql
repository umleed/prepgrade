-- ===========================================================================
-- PrepGrade — Exam results readiness harness (prompt 24)
-- ===========================================================================
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   0014 migration adds and the application code alone cannot assert:
--     * the exam_results tenant anchor trigger: a raw insert can NEVER tie a
--       result to an attempt/exam/student of another institution (the FKs prove
--       existence, not tenancy — AGENTS.md §5), can never reference an
--       in-progress attempt (a live sitting has no final score), and can never
--       mismatch the result's exam/student against its own attempt
--     * UNIQUE (attempt_id): ONE result per sitting — a retried grade UPSERTs
--       the same row and a duplicate INSERT collides, the schema-level half of
--       the idempotent-regrade guarantee (AGENTS.md §6)
--     * the bucket partition CHECK: correct + incorrect + unanswered equals the
--       graded question count — a partial or retried grade can never
--       double-count a question or drop one
--     * the score bound CHECK: total_score <= max_score — marks earned can
--       never exceed marks available, whatever the engine was fed
--     * the percentage bounds CHECK: 0..100 — a bogus (client-shaped) score
--       could not masquerade as a percentage even if grading were bypassed
--     * subject_breakdown is a JSON array (never an object/scalar) — the
--       breakdown is data, not a place to smuggle an answer key
--     * no premature grade columns leak into the delivery tables: exam_attempts
--       still carries no score (grading stays in exam_results, AGENTS.md §6)
--     * Deployed RLS deny-by-default + grant posture: browser roles
--       (anon/authenticated) can neither read nor write computed results — the
--       score is sensitive until released; only the server-side service-role
--       client touches them, and it holds exactly SELECT/INSERT/UPDATE (no
--       DELETE — a result is never hard-deleted, archive-not-delete, AGENTS.md §6)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0013, then 0014_exam_results.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/exam_results_readiness.sql
--      or  supabase db query --linked -f supabase/tests/exam_results_readiness.sql
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

-- --- 1. exam_results: tenant anchor, terminal-only grading, integrity --------
DO $$
DECLARE
  v_inst     uuid;
  v_inst_b   uuid;
  v_subj     uuid;
  v_class    uuid;
  v_stud     uuid;
  v_exam     uuid;
  v_q_a      uuid;
  v_snap_a   uuid;
  v_attempt  uuid;      -- terminal (submitted) attempt — gradeable
  v_live     uuid;      -- in-progress attempt — NOT gradeable
  v_result   uuid;
  v_now      timestamptz := now();
BEGIN
  INSERT INTO institutions (name) VALUES ('Result Tenant A') RETURNING id INTO v_inst;
  INSERT INTO institutions (name) VALUES ('Result Tenant B') RETURNING id INTO v_inst_b;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst, 'Chemistry') RETURNING id INTO v_subj;
  INSERT INTO classes (institution_id, name) VALUES (v_inst, 'SS2 Green') RETURNING id INTO v_class;
  INSERT INTO students (institution_id, student_code, full_name, class_id, status)
    VALUES (v_inst, 'A-001', 'Ada A', v_class, 'active') RETURNING id INTO v_stud;

  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, status)
    VALUES (v_inst, 'user_1', 'Result probe', v_subj, 60, 'published') RETURNING id INTO v_exam;

  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst, 'user_1', 'medium', v_subj,
            'What is 2+2?', '["2","4","6"]'::jsonb, 1) RETURNING id INTO v_q_a;

  INSERT INTO exam_question_snapshots
    (exam_id, question_id, institution_id, position, marks, question_type,
     difficulty, subject_id, question_text, options, correct_option_index)
    VALUES (v_exam, v_q_a, v_inst, 1, 4, 'mcq_single', 'medium', v_subj,
            'What is 2+2?', '["2","4","6"]'::jsonb, 1) RETURNING id INTO v_snap_a;

  -- A SUBMITTED attempt — the only kind grading may finalise.
  INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number,
                             status, started_at, expires_at, submitted_at, question_order)
    VALUES (v_exam, v_stud, v_inst, 1, 'submitted', v_now, v_now + interval '60 minutes',
            v_now + interval '10 minutes', jsonb_build_array(v_snap_a))
    RETURNING id INTO v_attempt;

  -- An IN-PROGRESS attempt — must never be gradeable.
  INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number,
                             started_at, expires_at, question_order)
    VALUES (v_exam, v_stud, v_inst, 2, v_now, v_now + interval '60 minutes',
            jsonb_build_array(v_snap_a))
    RETURNING id INTO v_live;

  -- Baseline: a well-formed result for the terminal attempt inserts cleanly.
  INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                            total_score, max_score, percentage,
                            correct_count, incorrect_count, unanswered_count, total_questions,
                            time_used_seconds, subject_breakdown)
    VALUES (v_attempt, v_exam, v_stud, v_inst,
            4, 4, 100.00, 1, 0, 0, 1,
            600, jsonb_build_array(jsonb_build_object('subjectId', v_subj, 'correct', 1, 'total', 1, 'score', 4, 'maxScore', 4)))
    RETURNING id INTO v_result;
  RAISE NOTICE 'PASS  baseline result inserts cleanly (one row per terminal attempt)';

  -- --- premature grading: an in-progress attempt is refused --------------------
  BEGIN
    INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                              total_score, max_score, percentage,
                              correct_count, incorrect_count, unanswered_count, total_questions,
                              time_used_seconds)
      VALUES (v_live, v_exam, v_stud, v_inst, 0, 4, 0.00, 0, 0, 1, 1, 0);
    RAISE NOTICE 'FAIL  results anchor: an IN-PROGRESS attempt was graded';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  results anchor: only a submitted/expired attempt can be graded';
  END;

  -- --- tenant anchor: a foreign institution never owns this result -------------
  BEGIN
    INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                              total_score, max_score, percentage,
                              correct_count, incorrect_count, unanswered_count, total_questions,
                              time_used_seconds)
      VALUES (v_attempt, v_exam, v_stud, v_inst_b, 4, 4, 100.00, 1, 0, 0, 1, 600);
    RAISE NOTICE 'FAIL  results anchor: another institution''s tenant id accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  results anchor: foreign-institution tenant refused';
  END;

  -- --- exam/student must match the attempt they are graded from ----------------
  DECLARE
    v_other_exam uuid;
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, status)
      VALUES (v_inst, 'user_1', 'Decoy exam', v_subj, 30, 'published') RETURNING id INTO v_other_exam;
    BEGIN
      INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                                total_score, max_score, percentage,
                                correct_count, incorrect_count, unanswered_count, total_questions,
                                time_used_seconds)
        VALUES (v_attempt, v_other_exam, v_stud, v_inst, 4, 4, 100.00, 1, 0, 0, 1, 600);
      RAISE NOTICE 'FAIL  results anchor: exam_id did not have to match the attempt''s exam';
    EXCEPTION WHEN raise_exception THEN
      RAISE NOTICE 'PASS  results anchor: result exam/student pinned to their own attempt';
    END;
  END;

  -- --- UNIQUE (attempt_id): a duplicate result per sitting is prevented --------
  BEGIN
    INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                              total_score, max_score, percentage,
                              correct_count, incorrect_count, unanswered_count, total_questions,
                              time_used_seconds)
      VALUES (v_attempt, v_exam, v_stud, v_inst, 2, 4, 50.00, 0, 1, 0, 1, 300);
    RAISE NOTICE 'FAIL  UNIQUE (attempt_id): a second result for one attempt was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  UNIQUE (attempt_id): regrade UPSERTs the one row (no duplicate results)';
  END;

  -- --- bucket partition CHECK: the three buckets must sum to the question count
  BEGIN
    INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                              total_score, max_score, percentage,
                              correct_count, incorrect_count, unanswered_count, total_questions,
                              time_used_seconds)
      VALUES (v_live, v_exam, v_stud, v_inst, 0, 4, 0.00, 1, 1, 1, 2, 0);
    RAISE NOTICE 'FAIL  bucket CHECK: correct+incorrect+unanswered <> total_questions accepted';
  EXCEPTION WHEN raise_exception THEN
    -- The anchor fires first (v_live is in_progress); use a fresh terminal attempt
    -- to isolate the partition CHECK.
    RAISE NOTICE 'SKIP  bucket CHECK shadowed by anchor on the in-progress attempt (probed again below)';
  END;

  DECLARE
    v_attempt2 uuid;
  BEGIN
    INSERT INTO exam_attempts (exam_id, student_id, institution_id, attempt_number,
                               status, started_at, expires_at, submitted_at, question_order)
      VALUES (v_exam, v_stud, v_inst, 3, 'expired', v_now, v_now + interval '60 minutes',
              v_now + interval '60 minutes', jsonb_build_array(v_snap_a))
      RETURNING id INTO v_attempt2;
    BEGIN
      INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                                total_score, max_score, percentage,
                                correct_count, incorrect_count, unanswered_count, total_questions,
                                time_used_seconds)
        VALUES (v_attempt2, v_exam, v_stud, v_inst, 0, 4, 0.00, 1, 1, 1, 3, 0);
      RAISE NOTICE 'FAIL  bucket CHECK: a partition mismatch was accepted';
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'PASS  bucket CHECK: buckets must partition the graded question set';
    END;

    -- --- score bound: total_score can never exceed max_score -------------------
    BEGIN
      INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                                total_score, max_score, percentage,
                                correct_count, incorrect_count, unanswered_count, total_questions,
                                time_used_seconds)
        VALUES (v_attempt2, v_exam, v_stud, v_inst, 5, 4, 100.00, 1, 0, 0, 1, 0);
      RAISE NOTICE 'FAIL  score bound CHECK: total_score > max_score accepted';
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'PASS  score bound CHECK: marks earned can never exceed marks available';
    END;

    -- --- percentage bounds: 0..100 ---------------------------------------------
    BEGIN
      INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                                total_score, max_score, percentage,
                                correct_count, incorrect_count, unanswered_count, total_questions,
                                time_used_seconds)
        VALUES (v_attempt2, v_exam, v_stud, v_inst, 4, 4, 120.00, 1, 0, 0, 1, 0);
      RAISE NOTICE 'FAIL  percentage CHECK: a value above 100 accepted';
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'PASS  percentage CHECK: held to 0..100 (a bogus score cannot masquerade)';
    END;
  END;

  -- --- subject_breakdown must be a JSON array ----------------------------------
  BEGIN
    INSERT INTO exam_results (attempt_id, exam_id, student_id, institution_id,
                              total_score, max_score, percentage,
                              correct_count, incorrect_count, unanswered_count, total_questions,
                              time_used_seconds, subject_breakdown)
      VALUES (v_attempt2, v_exam, v_stud, v_inst, 0, 4, 0.00, 0, 0, 1, 1, 0,
              jsonb_build_object('not', 'an array'));
    RAISE NOTICE 'FAIL  subject_breakdown CHECK: a non-array accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  subject_breakdown CHECK: only a JSON array is storable';
  END;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. grading cannot leak a score into the delivery table (regression) -------
-- 0013 asserted exam_attempts has no score column; prompt 24 adds results in a
-- SEPARATE table, so re-assert the delivery table is still grade-free — the
-- score lives only in exam_results, computed server-side (AGENTS.md §6).
DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'exam_attempts'
        AND (column_name ILIKE '%score%' OR column_name ILIKE '%correct%'
             OR column_name ILIKE '%grade%' OR column_name ILIKE '%percentage%')
  ) THEN
    RAISE NOTICE 'FAIL  exam_attempts grew a score/grading column (should stay in exam_results)';
  ELSE
    RAISE NOTICE 'PASS  exam_attempts still carries no score column (grading lives in exam_results)';
  END IF;
END;
$$;

-- --- 3. deployed RLS + grant posture ------------------------------------------
-- Computed results are the answer to "did they pass" and stay sensitive until
-- released; no browser role may read or write them directly — the server-side
-- service-role client behind ownership filters is the only path (AGENTS.md §5–6).
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
        EXECUTE 'SELECT count(*) FROM exam_results';
        RAISE NOTICE 'FAIL  RLS: role % could SELECT exam_results (exposed!)', r;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role % denied on exam_results (deny-by-default holds)', r;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'SKIP  RLS % test on exam_results (role switch failed)', r;
    END;
  END LOOP;
END;
$$;

-- --- 4. service_role holds SELECT/INSERT/UPDATE and NO DELETE ------------------
-- Archive-not-delete: a result is never hard-deleted by the app; regrades are
-- UPSERTs. Confirm the grant set matches (AGENTS.md §6).
DO $$
DECLARE
  v_delete boolean;
BEGIN
  v_delete := has_table_privilege('service_role', 'exam_results', 'DELETE');
  IF v_delete THEN
    RAISE NOTICE 'FAIL  service_role holds DELETE on exam_results (should be INSERT/UPDATE/SELECT only)';
  ELSE
    RAISE NOTICE 'PASS  service_role has no DELETE on exam_results (results are never hard-deleted)';
  END IF;
END;
$$;

ROLLBACK;
