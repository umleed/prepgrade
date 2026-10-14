-- ---------------------------------------------------------------------------
-- PrepGrade — 0009 question versions (prompt 16)
--
-- Scope: append-only edit history for the question bank. Prompt 16 requires
-- that editing a question never SILENTLY changes the meaning of content that
-- exams may already rely on (AGENTS.md §6: "Preserve a snapshot/version of
-- the questions and scoring rules used by a published exam so later edits do
-- not change historical results"). The exams area (prompts 17–19) will copy
-- question content into per-exam snapshots at publish time; until then — and
-- alongside it — this table preserves what a question said BEFORE each
-- meaning-changing edit, so any later exam snapshot, audit, or dispute can
-- reconstruct the exact content a student answered.
--
-- WHAT COUNTS AS A VERSION-WORTHY EDIT
-- Only meaning-bearing fields trigger a snapshot (question text, options,
-- correct answer index, marks, type) — decided by questionMeaningChanged() in
-- lib/questions.ts. The row here is the REPLACED content, written by the data
-- layer immediately before the UPDATE of the live row. Metadata-only fixes
-- (explanation, provenance, source, learning objective) never rewrite the
-- graded meaning and do not create versions.
--
-- APPEND-ONLY BY GRANT
-- service_role gets SELECT + INSERT only — no UPDATE, no DELETE — so even the
-- server cannot rewrite history once written. `version` is per-question and
-- strictly increasing (UNIQUE (question_id, version)); concurrent conflicting
-- edits surface as a unique-violation instead of silently overwriting a slot.
--
-- TENANT ISOLATION
-- institution_id is denormalised from the parent question and every read in
-- lib/data/questions.ts filters on it, matching the questions table itself.
-- RLS keeps the 0002–0006 posture: deny-by-default for browser roles — this
-- table carries archived answer keys, which students must never read even
-- with a valid Supabase session (AGENTS.md §6).
--
-- Apply after 0001–0006. Idempotent via IF NOT EXISTS. No seeds.
--
-- ROLLBACK implications:
--   DROP TABLE question_versions;
--   Destructive once edits exist — historical question content cannot be
--   regenerated.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS question_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id          uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  -- Denormalised from the parent question so tenant scoping is a single
  -- filter and never depends on joining through (possibly archived) rows.
  institution_id       uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- 1-based, per question: the snapshot that REPLACED content becomes v1 on
  -- the first meaning-changing edit, and so on.
  version              integer NOT NULL CHECK (version >= 1),
  -- --- snapshot of the replaced question content (mirrors 0006) ------------
  question_type        text NOT NULL
                         CHECK (question_type IN ('mcq_single')),
  difficulty           text NOT NULL
                         CHECK (difficulty IN ('easy','medium','hard')),
  subject_id           uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  topic_id             uuid REFERENCES topics(id) ON DELETE RESTRICT,
  exam_category_id     uuid REFERENCES exam_categories(id) ON DELETE RESTRICT,
  question_text        text NOT NULL
                         CHECK (char_length(trim(question_text)) BETWEEN 1 AND 5000),
  options              jsonb NOT NULL CHECK (
                         jsonb_typeof(options) = 'array'
                         AND jsonb_array_length(
                               CASE WHEN jsonb_typeof(options) = 'array'
                                    THEN options ELSE '[]'::jsonb END) BETWEEN 2 AND 8),
  correct_option_index integer NOT NULL CHECK (correct_option_index >= 0),
  explanation          text CHECK (explanation IS NULL OR char_length(explanation) <= 5000),
  marks                integer NOT NULL CHECK (marks BETWEEN 1 AND 50),
  learning_objective   text CHECK (learning_objective IS NULL OR char_length(learning_objective) <= 300),
  provenance           text NOT NULL
                         CHECK (provenance IN ('teacher_created','licensed')),
  source_label         text CHECK (source_label IS NULL OR char_length(source_label) <= 120),
  source_year          integer CHECK (source_year IS NULL OR source_year BETWEEN 1900 AND 2100),
  license_notes        text CHECK (license_notes IS NULL OR char_length(license_notes) <= 500),
  -- --- edit provenance ------------------------------------------------------
  -- Clerk id of the author of the archived content, and of the user whose
  -- edit caused this snapshot. Both server-derived; never client-supplied.
  authored_by          text NOT NULL CHECK (char_length(authored_by) BETWEEN 1 AND 100),
  edited_by            text NOT NULL CHECK (char_length(edited_by) BETWEEN 1 AND 100),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, version)
);

-- History reads for one question, newest snapshot first.
CREATE INDEX IF NOT EXISTS question_versions_question_version_idx
  ON question_versions (question_id, version DESC);
-- Tenant scoping filter used by every read and write.
CREATE INDEX IF NOT EXISTS question_versions_institution_idx
  ON question_versions (institution_id);

-- --- Row-level security: same deny-by-default posture as 0002–0006. --------
-- Archived answer keys live here; a browser role must not read them either.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE question_versions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE question_versions FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON question_versions FROM anon, authenticated';
END $$;

-- Append-only by grant: the server may read and add history, never edit or
-- erase it. (0006 grants UPDATE/DELETE on questions for the status lifecycle;
-- versions have no lifecycle — they only accumulate.)
GRANT SELECT, INSERT ON question_versions TO service_role;
