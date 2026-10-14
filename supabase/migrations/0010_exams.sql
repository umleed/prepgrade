-- ---------------------------------------------------------------------------
-- PrepGrade — 0010 exams (prompt 17)
--
-- Scope: the exam lifecycle the list and detail views are built on. One
-- tenant-owned exam row, plus the two links those views display:
--
--   * `exams` — title, description, subject, duration, availability window,
--     and the publication lifecycle status. The status vocabulary here
--     (draft → scheduled → published → closed, archived as the retire state)
--     is THE exam status model for prompts 17–19; nothing else may define a
--     competing one. It deliberately differs from the shared directory
--     lifecycle (active ⇄ archived in lib/classes.ts) because an exam is a
--     scheduled event, not a roster entry — "Active"/"Completed" in the UI
--     are DERIVED display states of a published exam's window, never stored.
--   * `exam_questions` — which bank questions make up the exam, in order,
--     with per-exam marks. Prompt 17 only READS it (the question count the
--     list and detail show); prompt 18's builder writes it and adds the
--     immutable content snapshots publishing needs (AGENTS.md §6).
--   * `exam_class_assignments` — the classes an exam is assigned to. Prompt
--     17 displays it ("assigned classes … where data exists"); prompt 19's
--     assignment flow writes it.
--
-- TENANT OWNERSHIP: `institution_id` is NOT NULL on every table. The FKs
-- prove a subject/question/class row EXISTS, not that it shares the exam's
-- institution — the triggers below anchor question→exam and class→exam
-- tenants, and the DATA LAYER (lib/data/exams.ts) validates the subject
-- against the caller's trusted tenant before any write (same posture as
-- 0006). Do not treat the FKs as the isolation boundary.
--
-- LIFECYCLE INTEGRITY (AGENTS.md §6): nothing here is hard-deleted by the
-- app — `archived` is the retire state, and attempts/results (prompts 22–25)
-- will hang off `exams.id`, so ids are stable forever. The window CHECK
-- guarantees a stored exam can never claim it ends before it starts.
--
-- Apply after 0001–0009. Idempotent via IF NOT EXISTS. No seeds — an exam
-- without real questions would be fabricated assessment content (AGENTS.md §7).
--
-- ROLLBACK implications:
--   DROP TABLE exam_class_assignments, exam_questions, exams;
--   DROP TRIGGER/FUNCTION exams_validate_window, exam_questions_validate_tenant,
--   exam_assignments_validate_tenant.
--   Destructive once rows exist — scheduled assessments cannot be regenerated.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- Clerk user id of the creator. Server-derived only — never client-supplied.
  created_by       text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 100),
  title            text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  description      text CHECK (description IS NULL OR char_length(description) <= 2000),
  subject_id       uuid NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 480),
  -- Availability window. Both nullable: a draft may be unscheduled. When both
  -- are set the window must be forward-ordered (CHECK below).
  starts_at        timestamptz,
  ends_at          timestamptz,
  -- THE exam lifecycle (prompt 17). Display-only refinements ("Active",
  -- "Completed") are derived from published + window in lib/exams.ts.
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','published','closed','archived')),
  -- Set by the server exactly when the exam first publishes; history anchor.
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exams_window_ordered
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS exams_institution_idx   ON exams (institution_id);
CREATE INDEX IF NOT EXISTS exams_subject_idx       ON exams (subject_id);
-- The list view's default read: a tenant's exams by lifecycle, newest first.
CREATE INDEX IF NOT EXISTS exams_tenant_status_created_idx
  ON exams (institution_id, status, created_at DESC);

DROP TRIGGER IF EXISTS exams_set_updated_at ON exams;
CREATE TRIGGER exams_set_updated_at
  BEFORE UPDATE ON exams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Subject anchor (same rule 0006 applies to questions): the subject must be
-- platform-shared or owned by the exam's institution. The data layer checks
-- first so users get field errors instead of exceptions; this is the
-- referential half that a raw insert cannot bypass.
CREATE OR REPLACE FUNCTION exams_validate_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_subject_inst uuid;
BEGIN
  SELECT institution_id INTO v_subject_inst
    FROM subjects WHERE id = NEW.subject_id;
  IF v_subject_inst IS NOT NULL
     AND v_subject_inst <> NEW.institution_id THEN
    RAISE EXCEPTION 'an exam must live under a subject visible to its own institution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exams_validate_subject ON exams;
CREATE TRIGGER exams_validate_subject
  BEFORE INSERT OR UPDATE OF subject_id, institution_id ON exams
  FOR EACH ROW EXECUTE FUNCTION exams_validate_subject();

-- --- exam ⇄ bank questions. Prompt 17 reads the count; prompt 18 owns the
--     selection UX and the published-exam content snapshots. `marks` lets one
--     question carry different weight in different exams (the bank default is
--     copied at selection time by the builder).
CREATE TABLE IF NOT EXISTS exam_questions (
  exam_id        uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id    uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- 1-based display order within the exam.
  position       integer NOT NULL CHECK (position >= 1),
  marks          integer NOT NULL DEFAULT 1 CHECK (marks BETWEEN 1 AND 50),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exam_id, question_id),
  UNIQUE (exam_id, position)
);

CREATE INDEX IF NOT EXISTS exam_questions_question_idx
  ON exam_questions (question_id);
CREATE INDEX IF NOT EXISTS exam_questions_tenant_idx
  ON exam_questions (institution_id);

-- A question may only join an exam of its own institution — the FK alone
-- proves existence, not tenancy (AGENTS.md §5).
CREATE OR REPLACE FUNCTION exam_questions_validate_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_question_inst uuid;
BEGIN
  SELECT institution_id INTO v_question_inst
    FROM questions WHERE id = NEW.question_id;
  IF v_question_inst IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'an exam may only contain questions of its own institution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exam_questions_validate_tenant ON exam_questions;
CREATE TRIGGER exam_questions_validate_tenant
  BEFORE INSERT OR UPDATE OF question_id, institution_id ON exam_questions
  FOR EACH ROW EXECUTE FUNCTION exam_questions_validate_tenant();

-- --- exam ⇄ assigned classes (displayed by prompt 17, written by prompt 19).
CREATE TABLE IF NOT EXISTS exam_class_assignments (
  exam_id        uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  class_id       uuid NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- Clerk user id that made the assignment. Server-derived only.
  assigned_by    text NOT NULL CHECK (char_length(assigned_by) BETWEEN 1 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exam_id, class_id)
);

CREATE INDEX IF NOT EXISTS exam_class_assignments_class_idx
  ON exam_class_assignments (class_id);
CREATE INDEX IF NOT EXISTS exam_class_assignments_tenant_idx
  ON exam_class_assignments (institution_id);

CREATE OR REPLACE FUNCTION exam_assignments_validate_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_class_inst uuid;
BEGIN
  SELECT institution_id INTO v_class_inst
    FROM classes WHERE id = NEW.class_id;
  IF v_class_inst IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'an exam may only be assigned to classes of its own institution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exam_assignments_validate_tenant ON exam_class_assignments;
CREATE TRIGGER exam_assignments_validate_tenant
  BEFORE INSERT OR UPDATE OF class_id, institution_id ON exam_class_assignments
  FOR EACH ROW EXECUTE FUNCTION exam_assignments_validate_tenant();

-- --- Row-level security: identical posture to 0001–0009 — deny-by-default
-- for browser-reachable roles; only the server-side service-role client (used
-- by lib/data/exams.ts behind a trusted institution_id filter) may touch
-- these tables. Exam rows carry question ids whose answer keys the grading
-- engine owns — no browser role ever reads them directly (AGENTS.md §6).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE exams ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exams FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exams FROM anon, authenticated';

  EXECUTE 'ALTER TABLE exam_questions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exam_questions FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exam_questions FROM anon, authenticated';

  EXECUTE 'ALTER TABLE exam_class_assignments ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exam_class_assignments FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exam_class_assignments FROM anon, authenticated';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON exams TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON exam_questions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON exam_class_assignments TO service_role;
