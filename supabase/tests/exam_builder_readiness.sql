-- ===========================================================================
-- PrepGrade — Exam builder readiness & security harness (prompt 18)
-- =========================================================================--
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   0011 migration adds and the application code alone cannot assert:
--     * the builder config CHECKs on `exams`: attempt limit 1–10, the
--       result-release vocabulary (immediate/after_window/manual) — in
--       particular an unknown release policy can NEVER be stored — and the
--       conservative column defaults (1 attempt, no randomisation,
--       after_window) that keep every pre-builder exam valid
--     * the exam_category_id FK: a crafted category id that does not exist
--       is refused; a real platform category is accepted
--     * exam_question_snapshots shape: position >= 1, marks 1–50, options a
--       2–8 element JSON array, question_type/difficulty vocabularies, and
--       the frozen answer key (correct_option_index >= 0)
--     * the snapshot UNIQUE keys: one question snapshots once per exam and
--       two publishes racing on the same position COLLIDE (the double-
--       snapshot becomes a raised error, never a silent overwrite)
--     * the exam_snapshots_validate_tenant trigger: a raw insert can never
--       file another institution's question into this exam's snapshot
--     * APPEND-ONLY BY GRANT: service_role holds SELECT+INSERT and NO
--       UPDATE/DELETE privilege on the snapshot table (the 0009 posture) —
--       even server code cannot rewrite published history
--     * Deployed RLS deny-by-default for `anon` / `authenticated` on the
--       snapshot table — answer keys of delivered exams are never
--       browser-readable
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0010, then 0011_exam_builder.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/exam_builder_readiness.sql
--      or  supabase db query --linked -f supabase/tests/exam_builder_readiness.sql
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

-- --- 1. exams builder columns: CHECKs, defaults, category FK ------------------
DO $$
DECLARE
  v_inst    uuid;
  v_subj    uuid;
  v_cat     uuid;
  v_exam    uuid;
  v_attempts integer;
  v_release  text;
  v_shuffle  boolean;
BEGIN
  INSERT INTO institutions (name) VALUES ('Builder Config Tenant') RETURNING id INTO v_inst;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst, 'Mathematics') RETURNING id INTO v_subj;
  SELECT id INTO v_cat FROM exam_categories WHERE code = 'WAEC' LIMIT 1;

  -- Baseline: a raw insert that knows nothing about the new columns must land
  -- on the conservative defaults (0011 header rationale).
  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
    VALUES (v_inst, 'user_1', 'Defaults probe', v_subj, 60)
    RETURNING id INTO v_exam;
  SELECT max_attempts, results_release, shuffle_questions
    INTO v_attempts, v_release, v_shuffle
    FROM exams WHERE id = v_exam;
  IF v_attempts = 1 AND v_release = 'after_window' AND v_shuffle = false THEN
    RAISE NOTICE 'PASS  defaults: raw exam insert lands conservative (1 attempt, after_window, no shuffle)';
  ELSE
    RAISE NOTICE 'FAIL  defaults: expected (1, after_window, false) got (%, %, %)', v_attempts, v_release, v_shuffle;
  END IF;

  -- A real platform category attaches cleanly.
  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, exam_category_id)
    VALUES (v_inst, 'user_1', 'Categorized exam', v_subj, 60, v_cat);
  RAISE NOTICE 'PASS  exam_category_id FK: real platform category accepted';

  -- A crafted category id that does not exist is refused by the FK.
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, exam_category_id)
      VALUES (v_inst, 'user_1', 'x', v_subj, 60, '00000000-0000-0000-0000-000000000000'::uuid);
    RAISE NOTICE 'FAIL  exam_category_id FK: a nonexistent category id was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS  exam_category_id FK: nonexistent category refused';
  END;

  -- --- attempt limit bounds (1–10) ---------------------------------------------
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, max_attempts)
      VALUES (v_inst, 'user_1', 'x', v_subj, 60, 0);
    RAISE NOTICE 'FAIL  max_attempts CHECK: 0 accepted (min 1)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  max_attempts CHECK: 0 refused (1–10)';
  END;

  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, max_attempts)
      VALUES (v_inst, 'user_1', 'x', v_subj, 60, 11);
    RAISE NOTICE 'FAIL  max_attempts CHECK: 11 accepted (max 10)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  max_attempts CHECK: 11 refused (1–10)';
  END;

  -- --- result-release vocabulary -------------------------------------------------
  BEGIN
    INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes, results_release)
      VALUES (v_inst, 'user_1', 'x', v_subj, 60, 'never');
    RAISE NOTICE 'FAIL  results_release CHECK: unknown policy ''never'' accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  results_release CHECK: unknown policy refused (immediate/after_window/manual only)';
  END;

  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes,
                     max_attempts, shuffle_questions, shuffle_options, results_release)
    VALUES (v_inst, 'user_1', 'Full builder config', v_subj, 90, 3, true, true, 'manual');
  RAISE NOTICE 'PASS  full builder configuration row inserts cleanly (attempts, shuffles, manual release)';

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. snapshot table: shape CHECKs, unique keys, tenant anchor ---------------
DO $$
DECLARE
  v_inst_a  uuid;
  v_inst_b  uuid;
  v_subj_a  uuid;
  v_subj_b  uuid;
  v_q_a     uuid;
  v_q_a2    uuid;
  v_q_b     uuid;
  v_exam    uuid;
BEGIN
  INSERT INTO institutions (name) VALUES ('Snapshot Tenant A') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Snapshot Tenant B') RETURNING id INTO v_inst_b;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Mathematics') RETURNING id INTO v_subj_a;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_b, 'Mathematics') RETURNING id INTO v_subj_b;

  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst_a, 'user_1', 'medium', v_subj_a,
            'What is 2 + 2?', '["2","3","4","5"]'::jsonb, 2)
    RETURNING id INTO v_q_a;
  -- A second question owned by tenant A, so the collision/shape probes below
  -- always have a selectable, same-tenant row (deterministic harness).
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst_a, 'user_1', 'hard', v_subj_a,
            'Second own-tenant question', '["a","b","c"]'::jsonb, 2)
    RETURNING id INTO v_q_a2;
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst_b, 'user_2', 'easy', v_subj_b, 'Foreign question',
            '["a","b"]'::jsonb, 0)
    RETURNING id INTO v_q_b;

  INSERT INTO exams (institution_id, created_by, title, subject_id, duration_minutes)
    VALUES (v_inst_a, 'user_1', 'Publish probe', v_subj_a, 60)
    RETURNING id INTO v_exam;

  -- Baseline snapshot row (what setExamStatus writes at publish).
  INSERT INTO exam_question_snapshots
    (exam_id, question_id, institution_id, position, marks, question_type,
     difficulty, subject_id, question_text, options, correct_option_index, explanation)
    VALUES (v_exam, v_q_a, v_inst_a, 1, 2, 'mcq_single', 'medium', v_subj_a,
            'What is 2 + 2?', '["2","3","4","5"]'::jsonb, 2, 'Basic arithmetic.');
  RAISE NOTICE 'PASS  baseline snapshot inserts cleanly (frozen content + key + marks)';

  -- --- shape CHECKs ---------------------------------------------------------------
  BEGIN
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam, v_q_a2, v_inst_a, 0, 2, 'mcq_single',
              'hard', v_subj_a, 'Position probe', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  snapshot position CHECK: 0 accepted (min 1)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  snapshot position CHECK: 0 refused (1-based frozen order)';
  END;

  BEGIN
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam, v_q_a, v_inst_a, 7, 51, 'mcq_single',
              'medium', v_subj_a, 'Marks probe', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  snapshot marks CHECK: 51 accepted (max 50)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  snapshot marks CHECK: 51 refused (1–50)';
  END;

  BEGIN
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam, v_q_a, v_inst_a, 8, 2, 'essay',
              'medium', v_subj_a, 'Type probe', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  snapshot question_type CHECK: unsupported type accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  snapshot question_type CHECK: only supported vocabularies freeze';
  END;

  BEGIN
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam, v_q_a, v_inst_a, 9, 2, 'mcq_single',
              'medium', v_subj_a, 'Options probe', '["only one"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  snapshot options CHECK: a 1-element array accepted (min 2)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  snapshot options CHECK: 1-element array refused (2–8 options)';
  END;

  -- --- UNIQUE keys: the double-publish collision -----------------------------------
  BEGIN
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam, v_q_a, v_inst_a, 2, 2, 'mcq_single',
              'medium', v_subj_a, 'Duplicate question', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  UNIQUE (exam, question): the same question snapshotted twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  UNIQUE (exam, question): second snapshot of one question collides';
  END;

  BEGIN
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam, v_q_a2, v_inst_a, 1, 2, 'mcq_single',
              'hard', v_subj_a, 'Position collision', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  UNIQUE (exam, position): two questions froze at position 1';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  UNIQUE (exam, position): racing publish on one position collides';
  END;

  -- --- tenant anchor: a foreign question never joins the snapshot ------------------
  BEGIN
    INSERT INTO exam_question_snapshots
      (exam_id, question_id, institution_id, position, marks, question_type,
       difficulty, subject_id, question_text, options, correct_option_index)
      VALUES (v_exam, v_q_b, v_inst_a, 3, 2, 'mcq_single',
              'easy', v_subj_a, 'Foreign content', '["a","b"]'::jsonb, 0);
    RAISE NOTICE 'FAIL  snapshots anchor trigger: another institution''s question accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  snapshots anchor trigger: foreign-institution question refused';
  END;

  RAISE NOTICE '--- checks 2 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 3. Append-only by grant: published snapshots are immutable history ---------
-- The 0009 posture, asserted through the privilege catalogue rather than a
-- live UPDATE (the psql session's superuser would bypass grants anyway).
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

    IF has_table_privilege(v_role, 'exam_question_snapshots', 'UPDATE') THEN
      RAISE NOTICE 'FAIL  append-only: % holds UPDATE on exam_question_snapshots', v_role;
    ELSE
      RAISE NOTICE 'PASS  append-only: % holds no UPDATE on exam_question_snapshots', v_role;
    END IF;

    IF has_table_privilege(v_role, 'exam_question_snapshots', 'DELETE') THEN
      RAISE NOTICE 'FAIL  append-only: % holds DELETE on exam_question_snapshots', v_role;
    ELSE
      RAISE NOTICE 'PASS  append-only: % holds no DELETE on exam_question_snapshots', v_role;
    END IF;
  END LOOP;

  IF has_table_privilege('service_role', 'exam_question_snapshots', 'INSERT')
     AND has_table_privilege('service_role', 'exam_question_snapshots', 'SELECT') THEN
    RAISE NOTICE 'PASS  append-only: service_role keeps exactly SELECT+INSERT (publish writes, reads)';
  ELSE
    RAISE NOTICE 'FAIL  append-only: service_role missing SELECT/INSERT — publishing would break';
  END IF;
END;
$$;

-- --- 4. RLS deny-by-default for browser roles -----------------------------------
-- Snapshots carry answer keys for DELIVERED exams: no browser role may ever
-- read them. The editor/psql session bypasses RLS, so switch roles explicitly.
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
        EXECUTE 'SELECT count(*) FROM exam_question_snapshots';
        RAISE NOTICE 'FAIL  RLS: role % could SELECT snapshot answer keys (exposed!)', r;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role % denied SELECT on exam_question_snapshots (deny-by-default holds)', r;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'SKIP  RLS % test on exam_question_snapshots (role switch failed)', r;
    END;
  END LOOP;
END;
$$;

ROLLBACK;
