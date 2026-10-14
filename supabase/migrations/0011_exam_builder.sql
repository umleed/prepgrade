-- ---------------------------------------------------------------------------
-- PrepGrade — 0011 exam builder (prompt 18)
--
-- Scope: what the builder configures and what publishing must make immutable.
--
--   * `exams` gains the assessment-configuration columns the builder exposes
--     and delivery (prompts 22–24) will read: the examination category
--     (platform lookup from 0005), an attempt limit, question/option
--     randomisation flags, and the result-release policy. Defaults keep every
--     pre-builder exam (and any raw insert) valid and conservative: one
--     attempt, no randomisation, results released only after the window ends
--     — never "immediate", because answer keys must not leak while the
--     window is still open for other students (AGENTS.md §6).
--   * `exam_question_snapshots` — the immutable copy of each published exam's
--     questions, options, answer key, explanation, marks, and order, written
--     exactly once when the exam publishes. Later bank edits (0009 versions)
--     and question archiving can never rewrite a delivered or historical
--     attempt (AGENTS.md §6). APPEND-ONLY BY GRANT, same posture as
--     `question_versions`: service_role may SELECT/INSERT only — no UPDATE,
--     no DELETE — so even server code cannot rewrite a published snapshot.
--
-- NOTHING HERE REOPENS PUBLISHED HISTORY: the 0010 lifecycle has no backward
-- transition out of `published`, so snapshots are written at most once per
-- exam; the unique keys below turn a concurrent double-publish into a
-- raised error rather than a silent overwrite.
--
-- TENANT OWNERSHIP: same posture as 0010 — `institution_id` NOT NULL, FKs
-- prove existence not tenancy, the anchor trigger below ties each snapshot
-- to its own exam's institution, and the DATA LAYER (lib/data/exams.ts)
-- validates every question/category id against the caller's trusted tenant
-- before writing. Do not treat the FKs as the isolation boundary.
--
-- Apply after 0001–0010. Idempotent. No seeds — snapshot rows are copies of
-- real teacher content, and fabricating assessment content is forbidden
-- (AGENTS.md §7).
--
-- ROLLBACK implications:
--   DROP TABLE exam_question_snapshots;
--   DROP TRIGGER/FUNCTION exam_snapshots_validate_tenant;
--   ALTER TABLE exams DROP COLUMN results_release, shuffle_options,
--   shuffle_questions, max_attempts, exam_category_id;
--   Destructive once snapshots exist — published exam content cannot be
--   regenerated from the live bank after questions change.
-- ---------------------------------------------------------------------------

-- --- Assessment configuration on the exam itself -----------------------------
ALTER TABLE exams
  ADD COLUMN IF NOT EXISTS exam_category_id uuid
    REFERENCES exam_categories(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS max_attempts integer
    CONSTRAINT exams_max_attempts_check NOT NULL DEFAULT 1
    CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS shuffle_questions boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shuffle_options boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS results_release text
    CONSTRAINT exams_results_release_check NOT NULL DEFAULT 'after_window'
    CHECK (results_release IN ('immediate','after_window','manual'));

-- The category is a platform lookup (0005): when set it must EXIST (the FK).
-- Archived categories stay referentially valid — an exam filed under a
-- category the platform later retires keeps resolving, same as subject
-- archiving in 0010. No tenant anchor is needed: the catalogue is
-- platform-wide. The data layer still only offers ACTIVE categories, so a
-- crafted id pointing at an archived row is refused in code before it can
-- reach a row.

-- --- published-exam content snapshots (prompt 18, AGENTS.md §6) --------------
CREATE TABLE IF NOT EXISTS exam_question_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id              uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id          uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  institution_id       uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- 1-based order taken at publish time; matches exam_questions.position then.
  position             integer NOT NULL CHECK (position >= 1),
  -- Per-exam marks copied at publish — the scoring rule attempts are graded
  -- against, frozen independently of the bank default (0010 copied `marks`
  -- into exam_questions at selection; publishing freezes that value here).
  marks                integer NOT NULL CHECK (marks BETWEEN 1 AND 50),
  question_type        text NOT NULL CHECK (question_type IN ('mcq_single')),
  difficulty           text NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  subject_id           uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  question_text        text NOT NULL
                         CHECK (char_length(trim(question_text)) BETWEEN 1 AND 5000),
  options              jsonb NOT NULL CHECK (
                         jsonb_typeof(options) = 'array'
                         AND jsonb_array_length(
                               CASE WHEN jsonb_typeof(options) = 'array'
                                    THEN options ELSE '[]'::jsonb END) BETWEEN 2 AND 8),
  -- Frozen WITH the content it indexes. Randomisation at delivery (prompts
  -- 22–23) permutes display while mapping back to this index — the answer
  -- key itself is never rewritten (AGENTS.md §6).
  correct_option_index integer NOT NULL CHECK (correct_option_index >= 0),
  explanation          text CHECK (explanation IS NULL OR char_length(explanation) <= 5000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- A question joins one exam's snapshot once; two concurrent publishes of
  -- the same exam collide here and RAISE instead of double-snapshotting.
  UNIQUE (exam_id, question_id),
  UNIQUE (exam_id, position)
);

CREATE INDEX IF NOT EXISTS exam_question_snapshots_exam_idx
  ON exam_question_snapshots (exam_id);
CREATE INDEX IF NOT EXISTS exam_question_snapshots_question_idx
  ON exam_question_snapshots (question_id);
CREATE INDEX IF NOT EXISTS exam_question_snapshots_tenant_idx
  ON exam_question_snapshots (institution_id);

-- Anchor (same rule as 0010's exam_questions): the snapshotted question must
-- belong to the SAME institution as its exam, even for a raw insert that
-- skips lib/data/exams.ts.
CREATE OR REPLACE FUNCTION exam_snapshots_validate_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_question_inst uuid;
BEGIN
  SELECT institution_id INTO v_question_inst
    FROM questions WHERE id = NEW.question_id;
  IF v_question_inst IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'a snapshot may only contain questions of its own exam''s institution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exam_snapshots_validate_tenant ON exam_question_snapshots;
CREATE TRIGGER exam_snapshots_validate_tenant
  BEFORE INSERT OR UPDATE OF question_id, institution_id ON exam_question_snapshots
  FOR EACH ROW EXECUTE FUNCTION exam_snapshots_validate_tenant();

-- --- Row-level security: identical deny-by-default posture to 0001–0010.
-- Snapshots carry answer keys for delivered exams — no browser role may ever
-- read them (AGENTS.md §6). Only the server-side service-role client writes
-- and reads, through lib/data/exams.ts behind a trusted institution filter.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE exam_question_snapshots ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exam_question_snapshots FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exam_question_snapshots FROM anon, authenticated';
END $$;

-- APPEND-ONLY BY GRANT (the 0009 posture): SELECT + INSERT are the widest
-- privilege this table ever grants — published content is history, and even
-- server code cannot rewrite or remove a snapshot row.
GRANT SELECT, INSERT ON exam_question_snapshots TO service_role;
