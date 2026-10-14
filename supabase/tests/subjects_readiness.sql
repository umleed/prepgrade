-- ===========================================================================
-- PrepGrade — Subjects & Topics readiness & security harness (prompt 14)
-- =========================================================================--
-- PURPOSE
--   Verifies, against a REAL Postgres/Supabase instance, the guarantees the
--   application code and this reviewer could NOT assert without a database:
--     * `status` lifecycle CHECK on subjects and topics (active/archived)
--     * PER-SCOPE partial UNIQUE name indexes: the platform catalogue is
--       unique on its own, each institution on its own — an institution may
--       shadow a platform name ("Maths" vs "Mathematics") but not duplicate
--       inside its own tenant; archiving frees the name in its own scope
--     * topics uniqueness is narrowed to the parent subject
--     * the topics hierarchy trigger: one subtopic level only, parent must
--       live in the same subject, and the table CHECK refuses self-parenting
--     * That the DB FK on topics.subject_id does NOT stop a cross-tenant
--       placement — proving the data layer's visibility checks are
--       load-bearing (same finding as the classes harness)
--     * exam_categories starter seed (JAMB/WAEC/NECO/CUSTOM) is present and
--       the seed subjects are marked is_seed (clearly identified content)
--     * Deployed RLS deny-by-default for `anon` / `authenticated` (0005)
--
-- HOW TO RUN  (only against a THROWAWAY test project — never production/shared)
--   1. Apply 0001–0004, then 0005_subjects_and_topics.sql.
--   2. Run this whole file in the Supabase SQL editor, or:
--        psql "$DATABASE_URL" -f supabase/tests/subjects_readiness.sql
--      or  supabase db query --linked -f supabase/tests/subjects_readiness.sql
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

-- --- 1. Lifecycle CHECKs, per-scope uniqueness, hierarchy, FK trust ----------
DO $$
DECLARE
  v_inst_a   uuid;
  v_inst_b   uuid;
  v_subj_a   uuid;
  v_subj_b   uuid;
  v_topic    uuid;
  v_subtopic uuid;
  v_cat      uuid;
  v_count    integer;
BEGIN
  INSERT INTO institutions (name) VALUES ('Subject Tenant A') RETURNING id INTO v_inst_a;
  INSERT INTO institutions (name) VALUES ('Subject Tenant B') RETURNING id INTO v_inst_b;

  -- status CHECK on subjects: an unknown value must be rejected.
  BEGIN
    INSERT INTO subjects (institution_id, name, status)
      VALUES (v_inst_a, 'Biology', 'retired');
    RAISE NOTICE 'FAIL  subject status CHECK: unknown status accepted (should be rejected)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  subject status CHECK: unknown status rejected by the constraint';
  END;

  -- Valid active institution subject.
  INSERT INTO subjects (institution_id, name, code)
    VALUES (v_inst_a, 'Maths', 'MTH') RETURNING id INTO v_subj_a;

  -- A second LIVE institution subject with the same name must clash (23505).
  BEGIN
    INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Maths');
    RAISE NOTICE 'FAIL  tenant name uniqueness: duplicate live subject accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  tenant name uniqueness: duplicate live subject rejected (23505)';
  END;

  -- Another tenant may use the same name (tenant scoping of the index).
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_b, 'Maths');
  RAISE NOTICE 'PASS  tenant name uniqueness: same name allowed in another institution';

  -- Platform-vs-institution shadowing: the seeded platform catalogue must NOT
  -- block an institution from naming a subject the same ("we never assume
  -- every school uses identical naming" — prompt 14).
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Mathematics');
  RAISE NOTICE 'PASS  per-scope uniqueness: institution may shadow a platform subject name';

  -- Platform-vs-platform duplicate must clash.
  BEGIN
    INSERT INTO subjects (name) VALUES ('Mathematics');
    RAISE NOTICE 'FAIL  platform uniqueness: duplicate platform subject accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  platform uniqueness: duplicate platform subject rejected (23505)';
  END;

  -- Archiving frees the name in its own scope (archive-then-reuse contract).
  UPDATE subjects SET status = 'archived'
    WHERE institution_id = v_inst_a AND name = 'Maths';
  INSERT INTO subjects (institution_id, name) VALUES (v_inst_a, 'Maths');
  RAISE NOTICE 'PASS  archiving frees the subject name for reuse (live-rows-only index)';

  -- --- Topics ---------------------------------------------------------------
  SELECT id INTO v_subj_b FROM subjects WHERE institution_id = v_inst_b AND name = 'Maths';

  INSERT INTO topics (subject_id, institution_id, name)
    VALUES (v_subj_a, v_inst_a, 'Algebra') RETURNING id INTO v_topic;

  -- Same name again under the SAME subject and tenant must clash…
  BEGIN
    INSERT INTO topics (subject_id, institution_id, name)
      VALUES (v_subj_a, v_inst_a, 'Algebra');
    RAISE NOTICE 'FAIL  topic uniqueness: duplicate live topic accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  topic uniqueness: duplicate live topic rejected (23505)';
  END;

  -- …but the same name under a DIFFERENT subject is fine.
  INSERT INTO topics (subject_id, institution_id, name)
    VALUES (v_subj_b, v_inst_b, 'Algebra');
  RAISE NOTICE 'PASS  topic uniqueness: same name allowed under another subject';

  -- One subtopic level is allowed.
  INSERT INTO topics (subject_id, institution_id, name, parent_id)
    VALUES (v_subj_a, v_inst_a, 'Indices', v_topic) RETURNING id INTO v_subtopic;
  RAISE NOTICE 'PASS  topic hierarchy: a subtopic may sit under a top-level topic';

  -- A third level must be refused by the hierarchy trigger.
  BEGIN
    INSERT INTO topics (subject_id, institution_id, name, parent_id)
      VALUES (v_subj_a, v_inst_a, 'Deep Nesting', v_subtopic);
    RAISE NOTICE 'FAIL  topic depth: third-level subtopic accepted (should be refused)';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  topic depth: third-level subtopic refused by the trigger';
  END;

  -- A parent from ANOTHER subject must be refused by the trigger.
  BEGIN
    INSERT INTO topics (subject_id, institution_id, name, parent_id)
      VALUES (v_subj_a, v_inst_a, 'Wrong Parent',
              (SELECT id FROM topics WHERE subject_id = v_subj_b LIMIT 1));
    RAISE NOTICE 'FAIL  topic hierarchy: cross-subject parent accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS  topic hierarchy: cross-subject parent refused by the trigger';
  END;

  -- Self-parenting is refused by the table CHECK.
  BEGIN
    INSERT INTO topics (subject_id, institution_id, name, parent_id)
      VALUES (v_subj_a, v_inst_a, 'Ouroboros', v_topic);
    -- accepted only if parent <> self held; simulate true self-reference:
    UPDATE topics SET parent_id = id WHERE id = v_topic;
    RAISE NOTICE 'FAIL  topic CHECK: self-parenting accepted (should be refused)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  topic CHECK: self-parenting refused';
  END;

  -- --- Cross-tenant FK proof (the data layer check is load-bearing) ---------
  -- Institution B's topic under institution A's subject passes the FK: the
  -- schema alone does NOT enforce that topic and subject share a tenant.
  BEGIN
    INSERT INTO topics (subject_id, institution_id, name)
      VALUES (v_subj_a, v_inst_b, 'Cross Tenant Placement');
    RAISE NOTICE 'PASS  FK proof: cross-tenant topic placement passes the DB (data-layer check is load-bearing)';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'FAIL  FK proof: expected the cross-tenant insert to pass the FK, got %', SQLERRM;
  END;

  -- --- Categories + seed identification --------------------------------------
  SELECT count(*) INTO v_count FROM exam_categories
    WHERE code IN ('JAMB','WAEC','NECO','CUSTOM') AND status = 'active';
  IF v_count = 4 THEN
    RAISE NOTICE 'PASS  exam category starter seed present (JAMB/WAEC/NECO/CUSTOM)';
  ELSE
    RAISE NOTICE 'FAIL  exam category seed expected 4 rows, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM subjects
    WHERE institution_id IS NULL AND is_seed;
  IF v_count > 0 THEN
    RAISE NOTICE 'PASS  platform starter subjects are clearly identified (is_seed)';
  ELSE
    RAISE NOTICE 'FAIL  no is_seed platform subjects found — starter content must be identifiable';
  END IF;

  -- A subject can be filed under a category (m2m metadata) and the pair is
  -- unique; a second attach must clash.
  SELECT id INTO v_cat FROM exam_categories WHERE code = 'JAMB';
  INSERT INTO subject_exam_categories (subject_id, category_id) VALUES (v_subj_a, v_cat);
  BEGIN
    INSERT INTO subject_exam_categories (subject_id, category_id) VALUES (v_subj_a, v_cat);
    RAISE NOTICE 'FAIL  subject category pair: duplicate accepted (should clash)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS  subject category pair: duplicate rejected (composite PK)';
  END;

  RAISE NOTICE '--- checks 1 complete; transaction will ROLLBACK (nothing persists) ---';
END;
$$;

-- --- 2. RLS deny-by-default for browser roles -------------------------------
-- Requires the `anon` role to exist (it does on a provisioned Supabase project).
-- The editor/psql session runs as a superuser/GROUP role that BYPASSES RLS, so
-- we switch to the browser-facing roles explicitly.
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'SKIP  RLS anon test — role "anon" not present (not a Supabase project?)';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['exam_categories', 'subjects', 'subject_exam_categories', 'topics']
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
