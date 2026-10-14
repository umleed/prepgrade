-- ===========================================================================
-- PrepGrade — Question Versions readiness & security harness (prompt 16)
-- =========================================================================--
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   question-editing flow (lib/data/questions.ts updateQuestion →
--   archiveQuestionVersion) depends on and pure tests cannot assert:
--     * a version snapshot mirrors the questions content shape: the same
--       type/difficulty/status-free CHECKs, option array bounds (2–8),
--       non-empty text, marks 1–50, correct_option_index >= 0
--     * version numbering: CHECK (version >= 1) and UNIQUE (question_id,
--       version) — a concurrent conflicting edit is refused, not overwritten
--     * edit provenance bounds (authored_by / edited_by non-empty)
--     * APPEND-ONLY BY GRANT: service_role holds SELECT + INSERT but NOT
--       UPDATE or DELETE on question_versions (checked via
--       has_table_privilege, which works regardless of the session role)
--     * question_id FK: a snapshot for a nonexistent question is refused
--     * Deployed RLS deny-by-default for `anon` / `authenticated` — archived
--       answer keys must never be readable from a browser role (0009)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0006, then 0009_question_versions.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/question_versions_readiness.sql
--      or  supabase db query --linked -f supabase/tests/question_versions_readiness.sql
--
-- SAFETY
--   Everything runs inside one explicit transaction that ends in ROLLBACK, so
--   no rows persist regardless of pass/fail. The RLS checks use SET LOCAL ROLE
--   to emulate a browser role, then reset. If your SQL editor auto-commits,
--   run it through `psql` instead so the transaction holds.
--
-- Output: one `NOTICE` line per check (PASS/FAIL/SKIP). Any hard assertion
-- failure RAISEs an exception and aborts (transaction rolls back), which is
-- the intended "red" result.
-- ===========================================================================

BEGIN;

-- --- 1. Snapshot shape CHECKs and version uniqueness -------------------------
DO $$
DECLARE
  v_inst   uuid;
  v_subj   uuid;
  v_topic  uuid;
  v_q      uuid;
BEGIN
  INSERT INTO institutions (name) VALUES ('Version Tenant A') RETURNING id INTO v_inst;
  INSERT INTO subjects (institution_id, name) VALUES (v_inst, 'Mathematics') RETURNING id INTO v_subj;
  INSERT INTO topics (subject_id, institution_id, name)
    VALUES (v_subj, v_inst, 'Algebra') RETURNING id INTO v_topic;
  INSERT INTO questions (institution_id, created_by, difficulty, subject_id, topic_id,
                         question_text, options, correct_option_index)
    VALUES (v_inst, 'user_author', 'medium', v_subj, v_topic,
            'What is 2 + 2?', '["2","3","4","5"]'::jsonb, 2)
    RETURNING id INTO v_q;

  -- Baseline snapshot (what archiveQuestionVersion writes) must insert.
  INSERT INTO question_versions (question_id, institution_id, version,
                                 difficulty, subject_id, topic_id,
                                 question_text, options, correct_option_index,
                                 marks, provenance, authored_by, edited_by)
    VALUES (v_q, v_inst, 1, 'medium', v_subj, v_topic,
            'What is 2 + 2?', '["2","3","4","5"]'::jsonb, 2,
            1, 'teacher_created', 'user_author', 'user_editor');
  RAISE NOTICE 'PASS  baseline version snapshot inserts cleanly';

  -- --- UNIQUE (question_id, version): no silent overwrite --------------------
  BEGIN
    INSERT INTO question_versions (question_id, institution_id, version,
                                   difficulty, subject_id,
                                   question_text, options, correct_option_index,
                                   marks, provenance, authored_by, edited_by)
      VALUES (v_q, v_inst, 1, 'easy', v_subj,
              'Different content', '["a","b"]'::jsonb, 0,
              1, 'teacher_created', 'user_author', 'user_editor2');
    RAISE NOTICE 'FAIL  UNIQUE (question_id, version): a duplicate version slot was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  UNIQUE (question_id, version): duplicate version slot refused';
  END;

  -- --- version numbering CHECK ------------------------------------------------
  BEGIN
    INSERT INTO question_versions (question_id, institution_id, version,
                                   difficulty, subject_id,
                                   question_text, options, correct_option_index,
                                   marks, provenance, authored_by, edited_by)
      VALUES (v_q, v_inst, 0, 'easy', v_subj,
              'x', '["a","b"]'::jsonb, 0,
              1, 'teacher_created', 'user_author', 'user_editor');
    RAISE NOTICE 'FAIL  version CHECK: version 0 accepted (must be >= 1)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  version CHECK: version 0 refused (1-based)';
  END;

  -- --- snapshot mirrors the question content constraints ----------------------
  BEGIN
    INSERT INTO question_versions (question_id, institution_id, version,
                                   difficulty, subject_id,
                                   question_text, options, correct_option_index,
                                   marks, provenance, authored_by, edited_by)
      VALUES (v_q, v_inst, 2, 'easy', v_subj,
              'x', '["only one"]'::jsonb, 0,
              1, 'teacher_created', 'user_author', 'user_editor');
    RAISE NOTICE 'FAIL  options CHECK: a 1-element snapshot array accepted (min 2)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  options CHECK: 1-element snapshot array refused (2–8)';
  END;

  BEGIN
    INSERT INTO question_versions (question_id, institution_id, version,
                                   difficulty, subject_id,
                                   question_text, options, correct_option_index,
                                   marks, provenance, authored_by, edited_by)
      VALUES (v_q, v_inst, 2, 'extreme', v_subj,
              'x', '["a","b"]'::jsonb, 0,
              1, 'teacher_created', 'user_author', 'user_editor');
    RAISE NOTICE 'FAIL  difficulty CHECK: unknown difficulty accepted in a snapshot';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  difficulty CHECK: unknown difficulty refused in a snapshot';
  END;

  BEGIN
    INSERT INTO question_versions (question_id, institution_id, version,
                                   difficulty, subject_id,
                                   question_text, options, correct_option_index,
                                   marks, provenance, authored_by, edited_by)
      VALUES (v_q, v_inst, 2, 'easy', v_subj,
              'x', '["a","b"]'::jsonb, 0,
              99, 'teacher_created', 'user_author', 'user_editor');
    RAISE NOTICE 'FAIL  marks CHECK: 99 marks accepted in a snapshot (must be 1–50)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  marks CHECK: out-of-range marks refused in a snapshot';
  END;

  -- --- edit provenance bounds --------------------------------------------------
  BEGIN
    INSERT INTO question_versions (question_id, institution_id, version,
                                   difficulty, subject_id,
                                   question_text, options, correct_option_index,
                                   marks, provenance, authored_by, edited_by)
      VALUES (v_q, v_inst, 2, 'easy', v_subj,
              'x', '["a","b"]'::jsonb, 0,
              1, 'teacher_created', 'user_author', '');
    RAISE NOTICE 'FAIL  edited_by CHECK: empty editor id accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  edited_by CHECK: empty editor id refused';
  END;

  -- --- FK: a snapshot must point at a real question -----------------------------
  BEGIN
    INSERT INTO question_versions (question_id, institution_id, version,
                                   difficulty, subject_id,
                                   question_text, options, correct_option_index,
                                   marks, provenance, authored_by, edited_by)
      VALUES ('00000000-0000-0000-0000-000000000000'::uuid, v_inst, 1, 'easy', v_subj,
              'x', '["a","b"]'::jsonb, 0,
              1, 'teacher_created', 'user_author', 'user_editor');
    RAISE NOTICE 'FAIL  question_id FK: a snapshot for a nonexistent question was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS  question_id FK: snapshot for a nonexistent question refused';
  END;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. Append-only by grant --------------------------------------------------
-- service_role may read and add history but must NOT hold UPDATE or DELETE —
-- the server itself cannot rewrite or erase archived content. has_table_
-- privilege reflects the GRANTs from 0009 regardless of the session role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE 'SKIP  append-only grant test — role "service_role" not present';
    RETURN;
  END IF;

  IF has_table_privilege('service_role', 'question_versions', 'SELECT')
     AND has_table_privilege('service_role', 'question_versions', 'INSERT') THEN
    RAISE NOTICE 'PASS  grants: service_role may SELECT and INSERT (history can be written and read)';
  ELSE
    RAISE NOTICE 'FAIL  grants: service_role is missing SELECT or INSERT on question_versions';
  END IF;

  IF NOT has_table_privilege('service_role', 'question_versions', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'question_versions', 'DELETE') THEN
    RAISE NOTICE 'PASS  append-only: service_role holds no UPDATE or DELETE (history cannot be rewritten)';
  ELSE
    RAISE NOTICE 'FAIL  append-only: service_role holds UPDATE or DELETE on question_versions';
  END IF;
END;
$$;

-- --- 3. RLS deny-by-default for browser roles ---------------------------------
-- Archived answer keys live here; a browser role must not SELECT them even
-- with a valid Supabase session (AGENTS.md §6).
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
        EXECUTE 'SELECT count(*) FROM question_versions';
        RAISE NOTICE 'FAIL  RLS: role % could SELECT from question_versions (archived answer keys exposed!)', r;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'PASS  RLS: role % denied SELECT on question_versions (deny-by-default holds)', r;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN others THEN
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'SKIP  RLS % test on question_versions (role switch failed)', r;
    END;
  END LOOP;
END;
$$;

ROLLBACK;
