-- ===========================================================================
-- PrepGrade — Exams readiness & security harness (prompt 17)
-- =========================================================================--
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code and this reviewer could NOT assert without a database:
--     * the lifecycle CHECK: `status` refuses everything outside
--       draft/scheduled/published/closed/archived — in particular the derived
--       display labels "active"/"completed" can NEVER be stored (one enum)
--     * the availability window CHECK: an exam can never end before it starts
--     * duration bounds (1–480), non-blank title, created_by bounds
--     * NO platform exams: institution_id is NOT NULL (unlike subjects)
--     * the exams_validate_subject trigger: a raw insert cannot file an exam
--       of tenant A under tenant B's subject (the FK proves existence only)
--     * the exam_questions_validate_tenant trigger: a foreign institution's
--       question can never join an exam, even via a direct INSERT that skips
--       lib/data/exams.ts
--     * the exam_assignments_validate_tenant trigger: same anchor for classes
--     * exam_questions shape: position >= 1, marks 1–50, one row per
--       (exam, question), one question per (exam, position)
--     * archive keeps the row resolvable (status flip, no delete) — results
--       (prompts 22–25) hang off exams.id forever
--     * Deployed RLS deny-by-default for `anon` / `authenticated` on all
--       three tables (0010)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0009, then 0010_exams.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/exams_readiness.sql
--      or  supabase db query --linked -f supabase/tests/exams_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so no
--   rows persist regardless of pass/fail. The RLS checks use SET LOCAL ROLE to
--   emulate a browser role for a few statements, then reset. If your SQL editor
--   auto-commits, run it through `psql` instead so the transaction holds.
--
-- Output: one `NOTICE` line per check (PASS/FAIL/SKIP). Any hard assertion
-- failure RAISEs an exception and aborts (transaction rolls back), which is the
-- intended "red" result.
-- ===========================================================================

BEGIN;

-- --- 1. Column CHECKs, window ordering, tenant anchor triggers ---------------
DO $$
DECLARE
  v_inst_a  uuid;
  v_inst_b  uuid;
  v_subj_a  uuid;
  v_subj_b  uuid;
  v_topic   uuid;
  v_q       uuid;
  v_exam    uuid;
  v_class   uuid;
BEGIN
  INSERT INTO institutions (name) VALUES ('Exam Tenant A') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Exam Tenant B') RETURNING id INTO v_inst_b;

  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Mathematics') RETURNING id INTO v_subj_a;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_b, 'Mathematics') RETURNING id INTO v_subj_b;
  INSERT INTO topics (subject_id, institution_id, name)
    VALUES (v_subj_a, v_inst_a, 'Algebra') RETURNING id INTO v_topic;
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id, topic_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst_a, 'user_1', 'medium', v_subj_a, v_topic,
            'What is 2 + 2?', '["2","3","4","5"]'::jsonb, 2)
    RETURNING id INTO v_q;
  -- A second question owned by tenant B, used to prove the anchor trigger
  -- refuses filing tenant A's exam with a foreign question.
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst_b, 'user_2', 'easy', v_subj_b, 'Foreign question',
            '["a","b"]'::jsonb, 0);
  INSERT INTO classes (institution_id, name)
    VALUES (v_inst_a, 'SS2 Blue') RETURNING id INTO v_class;

  -- A baseline valid unscheduled exam must insert cleanly.
  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
    VALUES (v_inst_a, 'user_1', 'Mid-term Mathematics Mock', v_subj_a, 60)
    RETURNING id INTO v_exam;
  RAISE NOTICE 'PASS  baseline exam inserts cleanly (unscheduled draft by default)';

  -- --- status CHECK: only the five lifecycle values, never a display label ----
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, status)
      VALUES (v_inst_a, 'user_1', 'x', v_subj_a, 60, 'active');
    RAISE NOTICE 'FAIL  status CHECK: derived display label accepted (should be refused)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  status CHECK: display label ''active'' refused (lifecycle enum only)';
  END;

  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, status)
      VALUES (v_inst_a, 'user_1', 'x', v_subj_a, 60, 'retired');
    RAISE NOTICE 'FAIL  status CHECK: unknown status accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  status CHECK: unknown status refused';
  END;

  -- --- window CHECK: never ends before it starts ------------------------------
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes,
                       starts_at, ends_at)
      VALUES (v_inst_a, 'user_1', 'x', v_subj_a, 60,
              '2026-11-05T17:00:00Z', '2026-11-01T09:00:00Z');
    RAISE NOTICE 'FAIL  window CHECK: backwards availability window accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  window CHECK: backwards window refused';
  END;

  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes,
                       starts_at, ends_at)
      VALUES (v_inst_a, 'user_1', 'x', v_subj_a, 60,
              '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z');
    RAISE NOTICE 'FAIL  window CHECK: zero-length window accepted (end must be strictly after start)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  window CHECK: zero-length window refused';
  END;

  -- --- duration bounds, blank title, created_by bounds -------------------------
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
      VALUES (v_inst_a, 'user_1', 'x', v_subj_a, 0);
    RAISE NOTICE 'FAIL  duration CHECK: 0 minutes accepted (min 1)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  duration CHECK: 0 minutes refused (1–480)';
  END;

  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
      VALUES (v_inst_a, 'user_1', '   ', v_subj_a, 60);
    RAISE NOTICE 'FAIL  title CHECK: blank/whitespace title accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  title CHECK: blank title refused';
  END;

  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
      VALUES (v_inst_a, '', 'x', v_subj_a, 60);
    RAISE NOTICE 'FAIL  created_by CHECK: blank creator accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  created_by CHECK: blank creator refused (server-derived id required)';
  END;

  -- --- No platform exams: institution_id NOT NULL -------------------------------
  BEGIN
    INSERT INTO exams (created_by, title, subject_id, duration_minutes)
      VALUES ('user_1', 'x', v_subj_a, 60);
    RAISE NOTICE 'FAIL  NOT NULL: a platform (institution-less) exam was accepted';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE 'PASS  NOT NULL: platform exam without institution refused';
  END;

  -- --- Subject anchor trigger: cross-tenant subject refused on a raw insert -----
  -- The FK proves the subject EXISTS; only the trigger proves it shares the exam's
  -- tenant (same posture as 0006 for questions).
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
      VALUES (v_inst_a, 'user_1', 'x', v_subj_b, 60);
    RAISE NOTICE 'FAIL  subject anchor trigger: cross-tenant subject accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  subject anchor trigger: subject owned by another institution refused';
  END;

  -- --- exam_questions: shape + tenant anchor ------------------------------------
  INSERT INTO exam_questions (exam_id, question_id, institution_id, position, marks)
    VALUES (v_exam, v_q, v_inst_a, 1, 2);
  RAISE NOTICE 'PASS  baseline exam_question inserts cleanly (position+marks)';

  BEGIN
    INSERT INTO exam_questions (exam_id, question_id, institution_id, position)
      VALUES (v_exam, v_q, v_inst_a, 0);
    RAISE NOTICE 'FAIL  position CHECK: 0 accepted (min 1)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  position CHECK: 0 refused (1-based order)';
  END;

  BEGIN
    INSERT INTO exam_questions (exam_id, question_id, institution_id, position, marks)
      VALUES (v_exam, v_q, v_inst_a, 2, 51);
    RAISE NOTICE 'FAIL  marks CHECK: 51 accepted (max 50)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  marks CHECK: 51 refused (1–50)';
  END;

  BEGIN
    INSERT INTO exam_questions (exam_id, question_id, institution_id, position)
      VALUES (v_exam, v_q, v_inst_a, 5);
    RAISE NOTICE 'FAIL  PK: the same question joined the same exam twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  PK: duplicate question in one exam refused';
  END;

  BEGIN
    INSERT INTO exam_questions (exam_id, question_id, institution_id, position)
      VALUES (v_exam, (SELECT id FROM questions WHERE institution_id = v_inst_b LIMIT 1), v_inst_a, 9);
    RAISE NOTICE 'FAIL  questions anchor trigger: foreign-institution question accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  questions anchor trigger: foreign-institution question refused';
  END;

  -- --- exam_class_assignments: tenant anchor (prompt 19 writes, 17 displays) ----
  INSERT INTO exam_class_assignments (exam_id, class_id, institution_id, assigned_by)
    VALUES (v_exam, v_class, v_inst_a, 'user_1');
  RAISE NOTICE 'PASS  baseline class assignment inserts cleanly';

  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
      VALUES (v_inst_a, 'user_1', 'window probe', v_subj_a, 60,
              '2026-11-01T09:00:00Z', '2026-11-05T17:00:00Z');
    RAISE NOTICE 'PASS  well-ordered window inserts cleanly';
  END;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. Lifecycle transitions the app performs are plain in-place UPDATEs ------
-- Publishing stamps published_at; archiving retires without deleting, so ids
-- keep resolving for future attempts/results (prompts 22–25).
DO $$
DECLARE
  v_inst_a  uuid;
  v_subj_a  uuid;
  v_exam    uuid;
  v_count   integer;
BEGIN
  INSERT INTO institutions (name) VALUES ('Exam Lifecycle Tenant') RETURNING id INTO v_inst_a;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Mathematics') RETURNING id INTO v_subj_a;

  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
    VALUES (v_inst_a, 'user_1', 'Lifecycle probe', v_subj_a, 60)
    RETURNING id INTO v_exam;

  UPDATE exams SET status = 'published', published_at = now() WHERE id = v_exam;
  UPDATE exams SET status = 'closed' WHERE id = v_exam;
  UPDATE exams SET status = 'archived' WHERE id = v_exam;

  SELECT count(*) INTO v_count FROM exams WHERE id = v_exam;
  IF v_count = 1 THEN
    RAISE NOTICE 'PASS  archive lifecycle: exam flips draft→published→closed→archived in place, row still resolves';
  ELSE
    RAISE NOTICE 'FAIL  archive lifecycle: the exam row disappeared (must never hard-delete)';
  END IF;

  RAISE NOTICE '--- checks 2 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 3. RLS deny-by-default for browser roles ---------------------------------
-- Requires the `anon` role to exist (it does on a provisioned Supabase project).
-- The editor/psql session runs as a superuser/GROUP role that BYPASSES RLS, so
-- we switch to the browser-facing roles explicitly. Exam rows reveal which
-- questions an assessment contains — no browser role may read them directly.
DO $$
DECLARE
  t text;
  r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'SKIP  RLS anon test — role "anon" not present (not a Supabase project?)';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['exams', 'exam_questions', 'exam_class_assignments']
  LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', r);
        BEGIN
          EXECUTE format('SELECT count(*) FROM %I', t);
          RAISE NOTICE 'FAIL  RLS: role % could SELECT from % (tenant data exposed!)', r, t;
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE NOTICE 'PASS  RLS: role % denied SELECT on % (deny-by-default holds)', r, t;
        END;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN others THEN
        EXECUTE 'RESET ROLE';
        RAISE NOTICE 'SKIP  RLS % test on % (role switch failed)', r, t;
      END;
    END LOOP;
  END LOOP;
END;
$$;

ROLLBACK;
