-- ===========================================================================
-- PrepGrade — Question Bank readiness & security harness (prompt 15)
-- =========================================================================--
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code and this reviewer could NOT assert without a database:
--     * the single-type MVP CHECK: `question_type` refuses everything but
--       'mcq_single' — the bank never stores a type the grader can't score
--     * lifecycle/type/difficulty/provenance CHECKs (status active/archived,
--       difficulty easy/medium/hard, provenance teacher_created/licensed)
--     * the option array shape: `options` must be a jsonb ARRAY of length
--       2–8; a non-array or an out-of-range array is refused by the constraint
--     * `correct_option_index >= 0` (the answer key is always a forward index)
--     * marks bounds (1–50), non-empty question text, created_by bounds
--     * NO platform questions: institution_id is NOT NULL (unlike subjects)
--     * the questions_validate_catalog trigger: a question's topic must belong
--       to the question's own subject, and its subject must be visible to the
--       question's institution (the referential half of tenant anchoring)
--     * Deployed RLS deny-by-default for `anon` / `authenticated` — doubly
--       important here because the answer key must never be readable from a
--       browser role (0006)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0005, then 0006_questions.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/questions_readiness.sql
--      or  supabase db query --linked -f supabase/tests/questions_readiness.sql
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

-- --- 1. Column CHECKs, option array shape, catalog anchor trigger ------------
DO $$
DECLARE
  v_inst_a  uuid;
  v_inst_b  uuid;
  v_subj_a  uuid;
  v_subj_b  uuid;
  v_topic   uuid;
  v_cat     uuid;
  v_q       uuid;
BEGIN
  INSERT INTO institutions (name) VALUES ('Question Tenant A') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Question Tenant B') RETURNING id INTO v_inst_b;

  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Mathematics') RETURNING id INTO v_subj_a;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_b, 'Mathematics') RETURNING id INTO v_subj_b;
  INSERT INTO topics (subject_id, institution_id, name)
    VALUES (v_subj_a, v_inst_a, 'Algebra') RETURNING id INTO v_topic;
  -- A topic under tenant B's subject, used to prove the anchor trigger refuses
  -- filing tenant A's question under a foreign-subject topic.
  INSERT INTO topics (subject_id, institution_id, name)
    VALUES (v_subj_b, v_inst_b, 'Algebra');
  SELECT id INTO v_cat FROM exam_categories WHERE code = 'JAMB';

  -- A baseline valid MCQ must insert cleanly.
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id, topic_id,
                         exam_category_id, question_text, options, correct_option_index)
    VALUES (v_inst_a, 'user_1', 'medium', v_subj_a, v_topic, v_cat,
            'What is 2 + 2?', '["2","3","4","5"]'::jsonb, 2)
    RETURNING id INTO v_q;
  RAISE NOTICE 'PASS  baseline MCQ inserts cleanly (subject+topic+category+options)';

  -- --- question_type CHECK: only the graded MCQ type is allowed ---------------
  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index, question_type)
      VALUES (v_inst_a, 'user_1', 'medium', v_subj_a, 'Pick all that apply',
              '["a","b"]'::jsonb, 0, 'multi_select');
    RAISE NOTICE 'FAIL  question_type CHECK: unsupported type accepted (should be refused)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  question_type CHECK: unsupported type refused (mcq_single only)';
  END;

  -- --- difficulty / status / provenance CHECKs --------------------------------
  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'extreme', v_subj_a, 'x', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  difficulty CHECK: unknown difficulty accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  difficulty CHECK: unknown difficulty refused';
  END;

  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index, status)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, 'x', '["a","b"]'::jsonb, 0, 'retired');
    RAISE NOTICE 'FAIL  status CHECK: unknown status accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  status CHECK: unknown status refused (active/archived only)';
  END;

  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index, provenance)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, 'x', '["a","b"]'::jsonb, 0, 'scraped');
    RAISE NOTICE 'FAIL  provenance CHECK: unknown provenance accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  provenance CHECK: unknown provenance refused';
  END;

  -- --- options array shape (jsonb, 2–8) ---------------------------------------
  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, 'x', '"not an array"'::jsonb, 0);
    RAISE NOTICE 'FAIL  options CHECK: a non-array value accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  options CHECK: non-array value refused';
  END;

  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, 'x', '["only one"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  options CHECK: a 1-element array accepted (min 2)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  options CHECK: 1-element array refused (min 2)';
  END;

  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, 'x',
              '["1","2","3","4","5","6","7","8","9"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  options CHECK: a 9-element array accepted (max 8)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  options CHECK: 9-element array refused (max 8)';
  END;

  -- --- answer key, marks, text bounds -----------------------------------------
  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, 'x', '["a","b"]'::jsonb, -1);
    RAISE NOTICE 'FAIL  correct_option_index CHECK: negative index accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  correct_option_index CHECK: negative index refused';
  END;

  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index, marks)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, 'x', '["a","b"]'::jsonb, 0, 0);
    RAISE NOTICE 'FAIL  marks CHECK: 0 marks accepted (min 1)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  marks CHECK: 0 marks refused (1–50)';
  END;

  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a, '   ', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  question_text CHECK: blank text accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  question_text CHECK: blank/whitespace text refused';
  END;

  -- --- No platform questions: institution_id NOT NULL -------------------------
  BEGIN
    INSERT INTO questions (created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES ('user_1', 'easy', v_subj_a, 'x', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  NOT NULL: a platform (institution-less) question was accepted';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE 'PASS  NOT NULL: platform question without institution refused';
  END;

  -- --- Catalog anchor trigger: topic must belong to the question's subject -----
  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id, topic_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_a,
              (SELECT id FROM topics WHERE subject_id = v_subj_b LIMIT 1),
              'x', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  catalog trigger: a foreign-subject topic was accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  catalog trigger: topic outside the question subject refused';
  END;

  -- --- Catalog anchor trigger: subject must be visible to the question tenant ---
  -- Institution A's question filed under Institution B's subject: the FK proves
  -- the subject EXISTS but not that it shares the tenant — the trigger does.
  BEGIN
    INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                           question_text, options, correct_option_index)
      VALUES (v_inst_a, 'user_1', 'easy', v_subj_b, 'x', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  catalog trigger: cross-tenant subject accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  catalog trigger: subject owned by another institution refused';
  END;

  -- --- Archive keeps the row resolvable (status flip, no delete) ---------------
  UPDATE questions SET status = 'archived' WHERE id = v_q;
  IF FOUND THEN
    RAISE NOTICE 'PASS  archive lifecycle: a live question flips to archived in place';
  ELSE
    RAISE NOTICE 'FAIL  archive lifecycle: baseline question not found to archive';
  END IF;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. RLS deny-by-default for browser roles -------------------------------
-- Requires the `anon` role to exist (it does on a provisioned Supabase project).
-- The editor/psql session runs as a superuser/GROUP role that BYPASSES RLS, so
-- we switch to the browser-facing roles explicitly. The answer key lives on this
-- table, so a browser role must not SELECT it even with a valid session.
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
        EXECUTE 'SELECT count(*) FROM questions';
        RAISE NOTICE 'FAIL  RLS: role % could SELECT from questions (answer key exposed!)', r;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role % denied SELECT on questions (deny-by-default holds)', r;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'SKIP  RLS % test on questions (role switch failed)', r;
    END;
  END LOOP;
END;
$$;

ROLLBACK;
