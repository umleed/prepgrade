-- ---------------------------------------------------------------------------
-- PrepGrade — 0005 subjects and topics (prompt 14)
--
-- Scope: the subject/topic catalogue that questions, exams, and performance
-- analytics will categorise (prompts 15–19, 27). Three shapes, one migration:
--
--   1. `exam_categories` — a PLATFORM lookup (JAMB, WAEC, NECO, Custom) that
--      prompts 15/17/18 hang examination metadata off. Seeded as clearly
--      identified starter content (`is_platform_seed` rows below); schools run
--      custom assessments through the 'CUSTOM' category rather than by editing
--      the platform rows.
--
--   2. `subjects` — one table, two scopes. `institution_id IS NULL` means the
--      PLATFORM catalogue (shared starter subjects, `is_seed` marks them);
--      a non-null `institution_id` is an institution-specific addition whose
--      tenant ownership is explicit on the row. Name uniqueness is per-scope
--      (partial unique indexes), so a school may add "Maths" even though the
--      platform catalogue already carries "Mathematics" — we never assume
--      every school uses identical naming.
--
--   3. `topics` — hang off a subject, with an optional `parent_id` for the
--      ONE level of subtopic depth prompts 15/27 need. A trigger refuses
--      deeper nesting and self-parenting. Same platform/institution split as
--      subjects, and an institution topic may live under a platform subject
--      (the subject stays shared; the topic row names its owning tenant).
--
-- HISTORY PRESERVATION (AGENTS.md §6): uuids are the stable identifiers the
-- future questions/exams/results/analytics rows will reference, and nothing
-- here is ever hard-deleted by the app — `status` flips active ⇄ archived so
-- historical results keep resolving their subject/topic even after the
-- catalogue moves on. Renaming is allowed; the id never changes.
--
-- TENANT NOTE (same finding as 0003/0004): the FK on `topics.subject_id`
-- proves the subject row EXISTS, not that it shares the topic's institution.
-- The DATA LAYER (lib/data/subjects.ts) validates every subject/parent/category
-- id against the caller's trusted tenant before writing. That check is
-- load-bearing — do not treat the FK as the isolation boundary.
--
-- Apply after 0001–0004. Idempotent via IF NOT EXISTS; seeds use ON CONFLICT
-- DO NOTHING so a re-run (or a school that renamed a starter subject) is safe.
--
-- ROLLBACK implications:
--   DROP TABLE subject_exam_categories, topics, subjects, exam_categories
--   (children first); DROP FUNCTION/TRIGGER topics_validate_hierarchy.
--   Destructive once rows exist — institution-added subjects/topics carry
--   data that cannot be regenerated.
-- ---------------------------------------------------------------------------

-- --- Examination categories (platform metadata) -----------------------------
CREATE TABLE IF NOT EXISTS exam_categories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
  name           text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  display_order  integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exam_categories_status_idx ON exam_categories (status);

DROP TRIGGER IF EXISTS exam_categories_set_updated_at ON exam_categories;
CREATE TRIGGER exam_categories_set_updated_at
  BEFORE UPDATE ON exam_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Starter content, clearly identified as such. 'CUSTOM' covers school-created
-- assessments (prompt 14 implementation notes). ON CONFLICT keeps re-runs and
-- pilot edits safe.
INSERT INTO exam_categories (code, name, display_order) VALUES
  ('JAMB',   'JAMB',                 10),
  ('WAEC',   'WAEC',                 20),
  ('NECO',   'NECO',                 30),
  ('CUSTOM', 'Custom school exam',   40)
ON CONFLICT (code) DO NOTHING;

-- --- Subjects: platform catalogue + explicit tenant additions ---------------
CREATE TABLE IF NOT EXISTS subjects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  code            text CHECK (code IS NULL OR char_length(trim(code)) BETWEEN 1 AND 12),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_seed         boolean NOT NULL DEFAULT false,  -- platform starter content
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subjects_institution_idx ON subjects (institution_id);
CREATE INDEX IF NOT EXISTS subjects_status_idx      ON subjects (status);

-- Per-scope name uniqueness among live rows: the platform catalogue is unique
-- on its own, each institution is unique on its own, and an institution may
-- therefore use a name the platform catalogue already carries. Archiving frees
-- the name in its own scope (same contract as classes_name_active_uidx).
CREATE UNIQUE INDEX IF NOT EXISTS subjects_platform_name_active_uidx
  ON subjects (lower(name))
  WHERE institution_id IS NULL AND status <> 'archived';
CREATE UNIQUE INDEX IF NOT EXISTS subjects_tenant_name_active_uidx
  ON subjects (institution_id, lower(name))
  WHERE institution_id IS NOT NULL AND status <> 'archived';

DROP TRIGGER IF EXISTS subjects_set_updated_at ON subjects;
CREATE TRIGGER subjects_set_updated_at
  BEFORE UPDATE ON subjects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Subject ↔ examination-category metadata --------------------------------
CREATE TABLE IF NOT EXISTS subject_exam_categories (
  subject_id  uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES exam_categories(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, category_id)
);

CREATE INDEX IF NOT EXISTS subject_exam_categories_category_idx
  ON subject_exam_categories (category_id);

-- --- Topics (one level of subtopics) ----------------------------------------
CREATE TABLE IF NOT EXISTS topics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id      uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  institution_id  uuid REFERENCES institutions(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES topics(id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_seed         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS topics_subject_idx     ON topics (subject_id);
CREATE INDEX IF NOT EXISTS topics_institution_idx ON topics (institution_id);
CREATE INDEX IF NOT EXISTS topics_parent_idx      ON topics (parent_id);
CREATE INDEX IF NOT EXISTS topics_status_idx      ON topics (status);

-- Same per-scope uniqueness as subjects, narrowed to the parent subject so
-- "Introduction" can exist under two different subjects.
CREATE UNIQUE INDEX IF NOT EXISTS topics_platform_name_active_uidx
  ON topics (subject_id, lower(name))
  WHERE institution_id IS NULL AND status <> 'archived';
CREATE UNIQUE INDEX IF NOT EXISTS topics_tenant_name_active_uidx
  ON topics (subject_id, institution_id, lower(name))
  WHERE institution_id IS NOT NULL AND status <> 'archived';

-- Hierarchy guard: a parent must be a TOP-IC (no parent of its own), so the
-- catalogue stays at subject → topic → subtopic and never grows into a tree
-- the analytics in prompt 27 would have to recurse over. The self-parent case
-- is caught by the table CHECK above; this catches the transitive one.
CREATE OR REPLACE FUNCTION topics_validate_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_parent uuid;
  v_parent_subject uuid;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT parent_id, subject_id INTO v_parent_parent, v_parent_subject
      FROM topics WHERE id = NEW.parent_id;
    IF v_parent_parent IS NOT NULL THEN
      RAISE EXCEPTION 'subtopics may not contain further subtopics (depth is limited to one level)';
    END IF;
    IF v_parent_subject <> NEW.subject_id THEN
      RAISE EXCEPTION 'a subtopic must live under a topic in the same subject';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS topics_validate_hierarchy ON topics;
CREATE TRIGGER topics_validate_hierarchy
  BEFORE INSERT OR UPDATE OF parent_id, subject_id ON topics
  FOR EACH ROW EXECUTE FUNCTION topics_validate_hierarchy();

DROP TRIGGER IF EXISTS topics_set_updated_at ON topics;
CREATE TRIGGER topics_set_updated_at
  BEFORE UPDATE ON topics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Starter subject catalogue (clearly identified seed content) ------------
-- A deliberately SMALL set of common Nigerian exam-prep subjects so a fresh
-- institution sees the shape of the catalogue; schools add their own names on
-- top (that is why per-scope uniqueness exists). is_seed marks these rows.
INSERT INTO subjects (name, code, is_seed) VALUES
  ('Mathematics',        'MTH', true),
  ('English Language',   'ENG', true),
  ('Physics',            'PHY', true),
  ('Chemistry',          'CHM', true),
  ('Biology',            'BIO', true),
  ('Government',         'GVT', true),
  ('Literature-in-English', 'LIT', true),
  ('Economics',          'ECO', true)
ON CONFLICT DO NOTHING;

-- Attach the seeded subjects to the three national exam categories so the
-- category metadata is demonstrably wired from day one.
INSERT INTO subject_exam_categories (subject_id, category_id)
SELECT s.id, c.id
FROM subjects s
CROSS JOIN exam_categories c
WHERE s.is_seed AND c.code IN ('JAMB', 'WAEC', 'NECO')
ON CONFLICT DO NOTHING;

-- A few starter topics under Mathematics and English Language, including one
-- subtopic to show the hierarchy. DO blocks resolve ids by name so re-runs
-- after a rename stay harmless.
DO $$
DECLARE
  v_math uuid;
  v_eng  uuid;
  v_num  uuid;
BEGIN
  SELECT id INTO v_math FROM subjects WHERE institution_id IS NULL AND lower(name) = 'mathematics' LIMIT 1;
  SELECT id INTO v_eng  FROM subjects WHERE institution_id IS NULL AND lower(name) = 'english language' LIMIT 1;

  IF v_math IS NOT NULL THEN
    INSERT INTO topics (subject_id, name, is_seed)
    VALUES
      (v_math, 'Number and Numeration', true),
      (v_math, 'Algebra',               true),
      (v_math, 'Geometry and Trigonometry', true)
    ON CONFLICT DO NOTHING;

    SELECT id INTO v_num FROM topics
    WHERE institution_id IS NULL AND subject_id = v_math
      AND lower(name) = 'number and numeration' LIMIT 1;

    IF v_num IS NOT NULL THEN
      INSERT INTO topics (subject_id, parent_id, name, is_seed)
      VALUES (v_math, v_num, 'Bases and Indices', true)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF v_eng IS NOT NULL THEN
    INSERT INTO topics (subject_id, name, is_seed)
    VALUES
      (v_eng, 'Reading Comprehension', true),
      (v_eng, 'Lexical Structures',    true),
      (v_eng, 'Oral English',          true)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- --- Row-level security: identical posture to 0002/0003/0004 — deny-by-default
-- for browser-reachable roles; only the server-side service-role client (which
-- the data layer uses with a trusted institution_id filter) may touch these.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'exam_categories',
    'subjects',
    'subject_exam_categories',
    'topics'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  exam_categories,
  subjects,
  subject_exam_categories,
  topics
TO service_role;
