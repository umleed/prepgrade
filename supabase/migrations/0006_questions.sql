-- ---------------------------------------------------------------------------
-- PrepGrade — 0006 questions (prompt 15)
--
-- Scope: the question bank every exam is assembled from (prompts 15–19). One
-- table, tenant-owned rows only:
--
--   * `institution_id` is NOT NULL — unlike subjects/topics there is NO
--     platform question catalogue. Starter content would mean fabricating
--     examination questions with answer keys, which AGENTS.md §7 forbids
--     (content rights). Every question is created by, and belongs to, one
--     institution; sharing beyond the tenant is a future, explicit decision.
--   * MVP supports ONE question type — single-answer multiple choice
--     (`mcq_single`). The CHECK deliberately lists only that value: the bank
--     never claims support for types the grading engine (prompt 24) cannot
--     score. Widening the enum is a future migration, not a silent edit.
--   * Options live in a jsonb array of strings (2–8). The answer key is
--     `correct_option_index` (0-based) on the SAME row — reachable only
--     through the server-side service-role client, so it can never leak to a
--     student via a browser role or a client bundle (AGENTS.md §6).
--   * Provenance/licensing metadata (AGENTS.md §7): `provenance`
--     (teacher_created | licensed), free-text `source_label` (e.g. "WAEC
--     2019"), `source_year`, and `license_notes`. Prompt 34 (import +
--     provenance) can widen the vocabulary without restructuring.
--
-- ORGANISATION (prompt 15): subject (required) + optional topic/subtopic +
-- optional exam category + difficulty + learning objective. The topic/subject
-- link is validated by a trigger so a question can never file itself under a
-- topic that belongs to a different subject — the same anchor rule the
-- catalogue enforces for subtopics (0005).
--
-- HISTORY PRESERVATION (AGENTS.md §6): uuids are stable; nothing is
-- hard-deleted by the app — `status` flips active ⇄ archived. Published-exam
-- snapshotting (prompt 17/18) will copy question content into exam snapshots,
-- so later edits here never rewrite historical results.
--
-- TENANT NOTE (same finding as 0003–0005): the FKs prove a subject/topic/
-- category row EXISTS, not that it shares the question's institution. The
-- DATA LAYER (lib/data/questions.ts) validates every subject/topic/category
-- id against the caller's trusted tenant before writing; the trigger below
-- additionally anchors topic→subject. Do not treat the FKs as the isolation
-- boundary.
--
-- Apply after 0001–0005. Idempotent via IF NOT EXISTS. No seeds — see above.
--
-- ROLLBACK implications:
--   DROP TABLE questions; DROP FUNCTION/TRIGGER questions_validate_catalog.
--   Destructive once rows exist — teacher-created content cannot be
--   regenerated.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS questions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id       uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- Clerk user id of the author. Server-derived only — never client-supplied
  -- (prompt 16 implementation notes); used for the "My questions" facet.
  created_by           text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 100),
  question_type        text NOT NULL DEFAULT 'mcq_single'
                         CHECK (question_type IN ('mcq_single')),
  difficulty           text NOT NULL
                         CHECK (difficulty IN ('easy','medium','hard')),
  subject_id           uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  -- A topic OR a subtopic (topics carry their own parent_id); the trigger
  -- below pins it to the same subject as the question.
  topic_id             uuid REFERENCES topics(id) ON DELETE RESTRICT,
  exam_category_id     uuid REFERENCES exam_categories(id) ON DELETE RESTRICT,
  question_text        text NOT NULL
                         CHECK (char_length(trim(question_text)) BETWEEN 1 AND 5000),
  -- JSON array of 2–8 non-empty option strings. Structure (trim, duplicates,
  -- per-option length) is validated in the data layer; the DB guarantees the
  -- array shape and bounds so a raw insert can never store a non-array.
  options              jsonb NOT NULL CHECK (
                         jsonb_typeof(options) = 'array'
                         AND jsonb_array_length(
                               CASE WHEN jsonb_typeof(options) = 'array'
                                    THEN options ELSE '[]'::jsonb END) BETWEEN 2 AND 8),
  -- 0-based index into `options`. Bounds against the actual array length are
  -- enforced in the data layer (the answer-key mapping integrity rule of
  -- AGENTS.md §6 lives with the code that writes it).
  correct_option_index integer NOT NULL CHECK (correct_option_index >= 0),
  explanation          text CHECK (explanation IS NULL OR char_length(explanation) <= 5000),
  marks                integer NOT NULL DEFAULT 1 CHECK (marks BETWEEN 1 AND 50),
  learning_objective   text CHECK (learning_objective IS NULL OR char_length(learning_objective) <= 300),
  source_label         text CHECK (source_label IS NULL OR char_length(source_label) <= 120),
  source_year          integer CHECK (source_year IS NULL OR source_year BETWEEN 1900 AND 2100),
  provenance           text NOT NULL DEFAULT 'teacher_created'
                         CHECK (provenance IN ('teacher_created','licensed')),
  license_notes        text CHECK (license_notes IS NULL OR char_length(license_notes) <= 500),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS questions_institution_idx ON questions (institution_id);
CREATE INDEX IF NOT EXISTS questions_subject_idx     ON questions (subject_id);
CREATE INDEX IF NOT EXISTS questions_topic_idx       ON questions (topic_id);
CREATE INDEX IF NOT EXISTS questions_category_idx    ON questions (exam_category_id);
CREATE INDEX IF NOT EXISTS questions_created_by_idx  ON questions (created_by);
-- The bank's default listing: a tenant's live questions, newest first.
CREATE INDEX IF NOT EXISTS questions_tenant_status_created_idx
  ON questions (institution_id, status, created_at DESC);

-- Catalogue anchor: a topic must exist, sit under the question's subject, and
-- be platform-shared or owned by the question's institution. The exam
-- category (platform lookup) must exist when set. FKs alone prove existence
-- only — this is the referential half of the rule; the data layer applies the
-- same checks first so users get field errors instead of exceptions.
CREATE OR REPLACE FUNCTION questions_validate_catalog()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_topic_subject uuid;
  v_topic_inst    uuid;
  v_subject_inst  uuid;
BEGIN
  SELECT institution_id INTO v_subject_inst
    FROM subjects WHERE id = NEW.subject_id;
  IF v_subject_inst IS NOT NULL
     AND v_subject_inst <> NEW.institution_id THEN
    RAISE EXCEPTION 'a question must live under a subject visible to its own institution';
  END IF;

  IF NEW.topic_id IS NOT NULL THEN
    SELECT subject_id, institution_id INTO v_topic_subject, v_topic_inst
      FROM topics WHERE id = NEW.topic_id;
    IF v_topic_subject <> NEW.subject_id THEN
      RAISE EXCEPTION 'the topic of a question must belong to the same subject';
    END IF;
    IF v_topic_inst IS NOT NULL
       AND v_topic_inst <> NEW.institution_id THEN
      RAISE EXCEPTION 'a question must live under a topic visible to its own institution';
    END IF;
  END IF;

  IF NEW.exam_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM exam_categories WHERE id = NEW.exam_category_id
  ) THEN
    RAISE EXCEPTION 'unknown exam category';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS questions_validate_catalog ON questions;
CREATE TRIGGER questions_validate_catalog
  BEFORE INSERT OR UPDATE OF subject_id, topic_id, exam_category_id, institution_id ON questions
  FOR EACH ROW EXECUTE FUNCTION questions_validate_catalog();

DROP TRIGGER IF EXISTS questions_set_updated_at ON questions;
CREATE TRIGGER questions_set_updated_at
  BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Row-level security: identical posture to 0002–0005 — deny-by-default
-- for browser-reachable roles. This matters doubly here: the answer key
-- (`correct_option_index`) must never be readable from a browser role even if
-- one somehow held a Supabase session (AGENTS.md §6). Only the server-side
-- service-role client (used by lib/data/questions.ts behind a trusted
-- institution_id filter) may touch this table.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE questions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE questions FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON questions FROM anon, authenticated';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON questions TO service_role;
