-- ---------------------------------------------------------------------------
-- PrepGrade — 0013 exam attempts (prompts 22–23)
--
-- Scope: the durable store the CBT interface and its attempt state machine
-- need. Two tables, both tenant-owned and reachable ONLY through the
-- server-side service-role client (lib/data/attempts.ts):
--
--   * `exam_attempts` — one row per student sitting. Carries the SERVER-
--     authoritative timing (`started_at`, `expires_at` stamped by the
--     server-side data layer from its own clock at start; the client only
--     ever displays the countdown derived from these), the attempt number
--     (bounded by the exam's frozen `max_attempts`), the terminal `status`
--     (in_progress → submitted | expired — `not_started` is the ABSENCE of a
--     row, never a status), and the per-attempt RANDOMISATION orders.
--     Question and option order are generated once at start and persisted
--     here so a refresh, a dropped connection, or a second tab all recover
--     the SAME view — and so grading
--     (prompt 24) can map a stored answer back to the frozen snapshot's
--     canonical option index without ever re-deriving (and thus desyncing) a
--     shuffle (AGENTS.md §6).
--   * `exam_attempt_answers` — one row per answered question, holding the
--     CANONICAL (snapshot) option index the student chose plus the
--     marked-for-review flag. Progressive autosave UPSERTs here on the
--     (attempt_id, snapshot_id) key, so a retried save is idempotent rather
--     than duplicated. Storing the canonical index — not the display slot —
--     is what keeps randomised options from corrupting the answer key.
--
-- WHAT IS DELIBERATELY ABSENT: any score, percentage, `is_correct`, or
-- marks-awarded column. Grading is prompt 24's job and is computed on the
-- server from the immutable snapshot + these stored answers; nothing here can
-- be written by, or trusted from, a client (AGENTS.md §6). Submitting LOCKS an
-- attempt (the data layer refuses answer writes once `status <> 'in_progress'`
-- or `expires_at` has passed); it does not grade.
--
-- TENANT OWNERSHIP (same posture as 0010–0012): `institution_id` NOT NULL on
-- every table; the FKs prove a student/exam/snapshot row EXISTS, not that it
-- shares the attempt's institution. The anchor triggers below tie
-- student→exam and snapshot→exam tenants so a raw insert cannot cross tenants,
-- and the DATA LAYER always filters by the caller's trusted `institution_id`
-- (resolved from the session, never a request body). Do not treat the FKs as
-- the isolation boundary.
--
-- ARCHIVE, NOT DELETE (AGENTS.md §6): an attempt is never hard-deleted by the
-- app — results (prompts 24–25) hang off `exam_attempts.id`, so ids are stable
-- forever. `ON DELETE CASCADE` only fires if an entire exam/student is removed
-- at the platform level, which the app never does.
--
-- Apply after 0001–0012. Idempotent via IF NOT EXISTS. No seeds — a fabricated
-- attempt would be fabricated student performance data (AGENTS.md §7).
--
-- ROLLBACK implications:
--   DROP TABLE exam_attempt_answers, exam_attempts;
--   DROP TRIGGER/FUNCTION exam_attempts_validate_tenant,
--   exam_attempt_answers_validate_tenant, exam_attempts_validate_snapshot.
--   Destructive once rows exist — real student attempts cannot be regenerated.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id          uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  institution_id   uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- 1-based sitting number, bounded by exams.max_attempts (1–10). The data
  -- layer counts prior attempts and refuses a start past the limit; the CHECK
  -- keeps a raw insert honest about the range.
  attempt_number   integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 10),
  -- The attempt lifecycle (prompt 23). `not_started` is intentionally absent:
  -- it is the absence of a row. `abandoned` is a future proctoring state and
  -- is not claimed until something can produce it honestly.
  status           text NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress','submitted','expired')),
  -- Server-authoritative timing. Both stamped by the server-side data layer
  -- at start; `expires_at` = min(started_at + exam duration, exam window end).
  -- The client never supplies or overrides either value.
  started_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  -- Set exactly once, when the attempt first reaches a terminal state.
  submitted_at     timestamptz,
  -- Per-attempt randomisation, persisted so recovery and grading agree.
  -- `question_order`: JSON array of exam_question_snapshots.id in DISPLAY
  -- order. `option_orders`: JSON object mapping snapshot id -> array whose
  -- d-th entry is the canonical option index shown at display slot d.
  -- Defaults are empty (no shuffle) and filled by the data layer at start.
  question_order   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(question_order) = 'array'),
  option_orders    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(option_orders) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A student sits a given attempt number at most once — the idempotency
  -- anchor for concurrent "start" clicks: two races collide here and the
  -- data layer treats the loser as "resume the winner's row", never a
  -- second parallel attempt.
  UNIQUE (exam_id, student_id, attempt_number),
  -- Timing can never be internally inconsistent: an attempt expires at or
  -- after it started.
  CONSTRAINT exam_attempts_window_ordered CHECK (expires_at >= started_at)
);

CREATE INDEX IF NOT EXISTS exam_attempts_exam_idx
  ON exam_attempts (exam_id);
CREATE INDEX IF NOT EXISTS exam_attempts_student_idx
  ON exam_attempts (student_id);
CREATE INDEX IF NOT EXISTS exam_attempts_tenant_idx
  ON exam_attempts (institution_id);
-- The delivery reads: "this student's live attempt for this exam" and
-- "count this student's attempts for this exam" (start-gate + resume).
CREATE INDEX IF NOT EXISTS exam_attempts_student_exam_idx
  ON exam_attempts (exam_id, student_id, attempt_number);

DROP TRIGGER IF EXISTS exam_attempts_set_updated_at ON exam_attempts;
CREATE TRIGGER exam_attempts_set_updated_at
  BEFORE UPDATE ON exam_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Anchor: the sitting student must belong to the SAME institution as the exam
-- they are attempting — the FK alone proves existence, not tenancy
-- (AGENTS.md §5). Closes the "student from school A starts an attempt on
-- school B's exam" hole a crafted id would otherwise open.
CREATE OR REPLACE FUNCTION exam_attempts_validate_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_student_inst uuid;
  v_exam_inst    uuid;
BEGIN
  SELECT institution_id INTO v_student_inst FROM students WHERE id = NEW.student_id;
  SELECT institution_id INTO v_exam_inst    FROM exams    WHERE id = NEW.exam_id;
  IF v_student_inst IS DISTINCT FROM NEW.institution_id
     OR v_exam_inst IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'an attempt must tie a student and an exam of the same institution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exam_attempts_validate_tenant ON exam_attempts;
CREATE TRIGGER exam_attempts_validate_tenant
  BEFORE INSERT OR UPDATE OF student_id, exam_id, institution_id ON exam_attempts
  FOR EACH ROW EXECUTE FUNCTION exam_attempts_validate_tenant();

-- --- progressive answers -----------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_attempt_answers (
  attempt_id           uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  -- The FROZEN snapshot question this answer is for (not the live bank row) —
  -- so an answer always resolves against the exact content that was delivered.
  snapshot_id          uuid NOT NULL REFERENCES exam_question_snapshots(id) ON DELETE RESTRICT,
  institution_id       uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- The CANONICAL (snapshot) option index chosen. NULLABLE: a row can exist
  -- purely to carry the marked-for-review flag before the student has picked
  -- an answer, so "answered" is `selected_option_index IS NOT NULL`. Bounds
  -- against the actual option count are enforced in the data layer (which
  -- knows the frozen options); the CHECK keeps a raw insert from storing a
  -- negative index.
  selected_option_index integer CHECK (selected_option_index >= 0),
  -- The navigator's "marked for review" flag — a study aid, carries no
  -- grading meaning.
  marked_for_review    boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- One answer per question per attempt: autosave UPSERTs on this key, so a
  -- retried or double-fired save overwrites rather than duplicating.
  PRIMARY KEY (attempt_id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS exam_attempt_answers_attempt_idx
  ON exam_attempt_answers (attempt_id);
CREATE INDEX IF NOT EXISTS exam_attempt_answers_tenant_idx
  ON exam_attempt_answers (institution_id);

DROP TRIGGER IF EXISTS exam_attempt_answers_set_updated_at ON exam_attempt_answers;
CREATE TRIGGER exam_attempt_answers_set_updated_at
  BEFORE UPDATE ON exam_attempt_answers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Anchor: the snapshotted question must belong to the SAME institution as the
-- attempt's tenant, and (via the attempt FK) to a real attempt. The data layer
-- additionally verifies the snapshot belongs to THIS attempt's exam before
-- writing; this trigger is the referential half a bypassed code path cannot
-- cross.
CREATE OR REPLACE FUNCTION exam_attempt_answers_validate_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot_inst uuid;
BEGIN
  SELECT institution_id INTO v_snapshot_inst
    FROM exam_question_snapshots WHERE id = NEW.snapshot_id;
  IF v_snapshot_inst IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'an answer must reference a snapshot question of its own institution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exam_attempt_answers_validate_tenant ON exam_attempt_answers;
CREATE TRIGGER exam_attempt_answers_validate_tenant
  BEFORE INSERT OR UPDATE OF snapshot_id, institution_id ON exam_attempt_answers
  FOR EACH ROW EXECUTE FUNCTION exam_attempt_answers_validate_tenant();

-- --- Row-level security: identical deny-by-default posture to 0001–0012. -----
-- These rows carry a student's live answers and the linkage to snapshots that
-- hold the answer keys — no browser role may ever read or write them directly.
-- Only the server-side service-role client (lib/data/attempts.ts), always
-- behind a trusted `institution_id` filter and an ownership check on
-- `student_id`, touches these tables (AGENTS.md §5, §6).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE exam_attempts ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exam_attempts FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exam_attempts FROM anon, authenticated';

  EXECUTE 'ALTER TABLE exam_attempt_answers ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exam_attempt_answers FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exam_attempt_answers FROM anon, authenticated';
END $$;

GRANT SELECT, INSERT, UPDATE ON exam_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE ON exam_attempt_answers TO service_role;
