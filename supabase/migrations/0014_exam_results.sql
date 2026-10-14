-- ---------------------------------------------------------------------------
-- PrepGrade — 0014 exam results (prompt 24)
--
-- Scope: the DURABLE output of the grading engine. Prompt 23 locks an attempt
-- on submit/expiry but deliberately stores no score; prompt 24 computes one on
-- the SERVER from the immutable `exam_question_snapshots` (frozen content +
-- answer key + marks) plus the student's recorded `exam_attempt_answers`, and
-- writes it here. One row per attempt — `attempt_id` is the PRIMARY KEY, so a
-- retried grade UPSERTs the same row instead of creating a duplicate result,
-- and an already-finalised result is never silently re-opened (AGENTS.md §6).
--
--   * `exam_results` — the score the student earned, the maximum available,
--     the percentage, correct/incorrect/unanswered counts, the time used, and
--     a subject-level performance breakdown, all computed server-side. These
--     are DERIVED FACTS, re-derivable from the snapshot + answers, so a regrade
--     of a locked attempt is idempotent: same inputs → same numbers.
--   * release visibility (`released_at`) records WHEN the exam's result-release
--     policy actually let this result become visible. The policy itself lives
--     on `exams.results_release` (0011) and is judged by the pure rule in
--     lib/grading.ts; the result views (prompt 25) read this stamp — nothing
--     here exposes an answer key or explanation to a student early.
--
-- WHAT IS DELIBERATELY ABSENT: any client-writable score. This table is written
-- ONLY by the server-side grading data layer (lib/data/grading.ts) after an
-- attempt reaches a terminal state; the client never inserts or updates it, and
-- no browser role is granted any access (RLS deny-by-default below).
--
-- `graded` as an attempt STATUS stays out: the delivery state machine (0013)
-- keeps its three honest states (in_progress/submitted/expired) so its tests
-- and its lock semantics do not drift. "Has been graded" is expressed HERE, by
-- the existence of a result row — the grading artifact — not by widening the
-- delivery enum with a state the delivery layer can neither produce nor need.
--
-- TENANT OWNERSHIP (same posture as 0010–0013): `institution_id` NOT NULL on
-- every row; the FKs prove an exam/student/attempt row EXISTS, not that it
-- shares the result's institution. The anchor trigger below ties the whole row
-- to ONE institution (attempt → exam → student all match the result's tenant),
-- and the DATA LAYER always filters by the caller's trusted `institution_id`
-- (resolved from the session, never a request body). Do not treat the FKs as
-- the isolation boundary.
--
-- ARCHIVE, NOT DELETE (AGENTS.md §6): a result is never hard-deleted by the
-- app — analytics and reporting (prompts 25+) hang off it, so ids are stable
-- forever. `ON DELETE CASCADE` only fires if an entire attempt is removed at
-- the platform level, which the app never does.
--
-- Apply after 0001–0013. Idempotent via IF NOT EXISTS. No seeds — a fabricated
-- result would be fabricated student performance data (AGENTS.md §7).
--
-- ROLLBACK implications:
--   DROP TABLE exam_results;
--   DROP TRIGGER/FUNCTION exam_results_validate_tenant.
--   Destructive once rows exist — computed results can be regenerated from the
--   snapshots + answers, but released history would be lost.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_results (
  -- One result per attempt, keyed by it: the idempotency anchor for a retried
  -- grade. A regrade UPSERTs this row rather than duplicating it, and a locked
  -- attempt's inputs cannot change, so the UPSERT is a true no-op.
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id         uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  exam_id            uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  institution_id     uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,

  -- Marks actually earned (sum of per-question marks whose chosen canonical
  -- option equals the frozen answer key). Integer because every snapshot mark
  -- is an integer (0011); a fractional outcome is expressed via `percentage`.
  total_score        integer NOT NULL CHECK (total_score >= 0),
  -- Sum of every question's frozen marks — the denominator. Bounded the same
  -- way a published exam's marks are (>=1 once questions exist).
  max_score          integer NOT NULL CHECK (max_score >= 0),
  -- Score as a percentage of max, rounded to whole hundredths (e.g. 66.67).
  -- 0 for a degenerate 0-mark exam so a division never yields NaN/NULL. A
  -- non-integer outcome is expected and correct (decimal marks support).
  percentage         numeric(5,2) NOT NULL CHECK (percentage >= 0 AND percentage <= 100),

  -- The three disjoint answer buckets. Their sum is exactly the number of
  -- questions graded, enforced below, so a partial/again-retried grade can
  -- never double-count a question or drop one.
  correct_count      integer NOT NULL CHECK (correct_count >= 0),
  incorrect_count    integer NOT NULL CHECK (incorrect_count >= 0),
  unanswered_count   integer NOT NULL CHECK (unanswered_count >= 0),
  total_questions    integer NOT NULL CHECK (total_questions >= 0),

  -- Time the student actually used, in whole seconds: the server-clock span
  -- from `started_at` to the attempt's terminal stamp, clamped by the data
  -- layer to the attempt window. Never client-supplied.
  time_used_seconds  integer NOT NULL CHECK (time_used_seconds >= 0),

  -- Per-subject performance, built ONLY from the frozen snapshot's valid
  -- `subject_id` metadata + recorded answers (never inferred): an array of
  -- { subjectId, correct, total, score, maxScore }. Empty when a snapshot row
  -- carries no resolvable subject — a broken id is skipped, never fabricated.
  subject_breakdown  jsonb NOT NULL DEFAULT '[]'::jsonb
                       CHECK (jsonb_typeof(subject_breakdown) = 'array'),

  -- The result reaches a student only once the exam's release policy allows it.
  -- NULL = not yet released; set by the grading layer at the moment visibility
  -- is permitted (immediate/after-window) or by an explicit release (manual).
  released_at        timestamptz,
  -- When this result was (last) computed on the server. History anchor.
  graded_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Integrity: the buckets partition the question set exactly.
  CONSTRAINT exam_results_buckets_partition
    CHECK (correct_count + incorrect_count + unanswered_count = total_questions),
  -- Integrity: marks earned can never exceed marks available.
  CONSTRAINT exam_results_score_bounded
    CHECK (total_score <= max_score),
  -- One result per attempt (the UPSERT key). `attempt_id` is already the
  -- PRIMARY KEY column via a separate id, so pin uniqueness on the FK too.
  CONSTRAINT exam_results_attempt_unique UNIQUE (attempt_id)
);

CREATE INDEX IF NOT EXISTS exam_results_exam_idx
  ON exam_results (exam_id);
CREATE INDEX IF NOT EXISTS exam_results_student_idx
  ON exam_results (student_id);
CREATE INDEX IF NOT EXISTS exam_results_tenant_idx
  ON exam_results (institution_id);
-- The results list read: one student's released results, newest graded first.
CREATE INDEX IF NOT EXISTS exam_results_student_graded_idx
  ON exam_results (student_id, graded_at DESC);

DROP TRIGGER IF EXISTS exam_results_set_updated_at ON exam_results;
CREATE TRIGGER exam_results_set_updated_at
  BEFORE UPDATE ON exam_results
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Anchor: the attempt, its exam, and its student must ALL belong to the SAME
-- institution as the result row, and the attempt must already be TERMINAL
-- (submitted/expired) — an in-progress attempt has no final score to record.
-- The FKs alone prove existence, not tenancy (AGENTS.md §5); this trigger
-- closes the cross-tenant and premature-grading holes a raw insert could
-- otherwise open.
CREATE OR REPLACE FUNCTION exam_results_validate_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_attempt_inst uuid;
  v_attempt_exam uuid;
  v_attempt_stud uuid;
  v_attempt_stat text;
  v_exam_inst    uuid;
  v_stud_inst    uuid;
BEGIN
  SELECT institution_id, exam_id, student_id, status
    INTO v_attempt_inst, v_attempt_exam, v_attempt_stud, v_attempt_stat
    FROM exam_attempts WHERE id = NEW.attempt_id;

  IF v_attempt_inst IS NULL THEN
    RAISE EXCEPTION 'a result must reference an existing attempt';
  END IF;
  IF v_attempt_stat = 'in_progress' THEN
    RAISE EXCEPTION 'only a submitted or expired attempt can be graded';
  END IF;

  SELECT institution_id INTO v_exam_inst FROM exams    WHERE id = NEW.exam_id;
  SELECT institution_id INTO v_stud_inst FROM students WHERE id = NEW.student_id;

  IF v_attempt_exam IS DISTINCT FROM NEW.exam_id
     OR v_attempt_stud IS DISTINCT FROM NEW.student_id THEN
    RAISE EXCEPTION 'a result must tie its attempt to the same exam and student';
  END IF;
  IF v_exam_inst   IS DISTINCT FROM NEW.institution_id
     OR v_stud_inst IS DISTINCT FROM NEW.institution_id
     OR v_attempt_inst IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'a result must live entirely within one institution';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exam_results_validate_tenant ON exam_results;
CREATE TRIGGER exam_results_validate_tenant
  BEFORE INSERT OR UPDATE OF attempt_id, exam_id, student_id, institution_id ON exam_results
  FOR EACH ROW EXECUTE FUNCTION exam_results_validate_tenant();

-- --- Row-level security: identical deny-by-default posture to 0001–0013. -----
-- These rows are computed student performance — the answer to "did they pass".
-- No browser role may read or write them directly: only the server-side
-- grading data layer (lib/data/grading.ts) and the result views (prompt 25),
-- always behind a trusted `institution_id` filter and an ownership check,
-- touch them. Answer keys never live here anyway (they stay in the snapshot),
-- but the score itself is sensitive until released (AGENTS.md §5, §6).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE exam_results ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exam_results FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exam_results FROM anon, authenticated';
END $$;

GRANT SELECT, INSERT, UPDATE ON exam_results TO service_role;
