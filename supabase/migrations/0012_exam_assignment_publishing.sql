-- ---------------------------------------------------------------------------
-- PrepGrade — 0012 exam assignment & publishing (prompt 19)
--
-- Scope: the audience half of the assignment workflow. Prompt 19 lets an
-- exam be assigned to whole classes (0010's `exam_class_assignments`) AND
-- to individual students, so this migration adds:
--
--   * `exam_student_assignments` — per-student audience rows. Same tenant
--     posture as every other table: institution_id NOT NULL, the FK proves
--     the student EXISTS but not that it shares the exam's institution, so
--     the anchor trigger below ties student→exam tenants and the DATA LAYER
--     (lib/data/exams.ts) validates every id against the caller's trusted
--     tenant before writing.
--   * `exams.published_to` — the audience SIZE frozen at publish time.
--     Assignments stay editable only while the exam is draft/scheduled, and
--     publishing records how many students the exam was released to, so the
--     publish/assignment action is honestly reconstructable even if the
--     audience rows are later revised (AGENTS.md §6: preserve history).
--
-- ARCHIVE, NOT DELETE (AGENTS.md §6): un-assigning a student REVOKES the
-- row (`status = 'revoked'`) instead of removing it — attempts and results
-- (prompts 22–25) will hang off this assignment, so the record of "this
-- student was given this exam" must survive. Re-assigning flips the same
-- row back to `active` (partial unique index allows exactly one live row
-- per (exam, student) while keeping the revocation trail). Class rows have
-- no such marker because a class's roster is derived live; de-selecting a
-- class before publish removes its rows (nothing has been delivered yet).
--
-- Apply after 0001–0011. Idempotent via IF NOT EXISTS. No seeds — an
-- assignment to a fabricated student would be fabricated tenant data.
--
-- ROLLBACK implications:
--   DROP TABLE exam_student_assignments;
--   DROP TRIGGER/FUNCTION exam_student_assignments_validate_tenant;
--   ALTER TABLE exams DROP COLUMN published_to;
--   Destructive once assignments exist — the record of who was given which
--   exam cannot be regenerated.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_student_assignments (
  exam_id        uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  -- Clerk user id that made the assignment. Server-derived only.
  assigned_by    text NOT NULL CHECK (char_length(assigned_by) BETWEEN 1 AND 100),
  -- `revoked` is this table's archive state: the row stays so delivery and
  -- results can still resolve "was this student assigned?", but the data
  -- layer refuses to count or grant access from a revoked row.
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','revoked')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One row per (exam, student) EVER is not required — a revoke followed by
  -- a re-assign reuses the row — but two live rows never coexist; enforced
  -- by the partial unique index below so the trail survives.
  UNIQUE (exam_id, student_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS exam_student_assignments_active_uidx
  ON exam_student_assignments (exam_id, student_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS exam_student_assignments_student_idx
  ON exam_student_assignments (student_id);
CREATE INDEX IF NOT EXISTS exam_student_assignments_tenant_idx
  ON exam_student_assignments (institution_id);
-- Delivery-side read (prompts 20–23): "everything assigned to this student".
CREATE INDEX IF NOT EXISTS exam_student_assignments_student_active_idx
  ON exam_student_assignments (student_id, exam_id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS exam_student_assignments_set_updated_at
  ON exam_student_assignments;
CREATE TRIGGER exam_student_assignments_set_updated_at
  BEFORE UPDATE ON exam_student_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Anchor (same rule as 0010's exam_class_assignments): the student must
-- belong to the SAME institution as the exam — the FK alone proves
-- existence, not tenancy (AGENTS.md §5).
CREATE OR REPLACE FUNCTION exam_student_assignments_validate_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_student_inst uuid;
BEGIN
  SELECT institution_id INTO v_student_inst
    FROM students WHERE id = NEW.student_id;
  IF v_student_inst IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'an exam may only be assigned to students of its own institution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exam_student_assignments_validate_tenant
  ON exam_student_assignments;
CREATE TRIGGER exam_student_assignments_validate_tenant
  BEFORE INSERT OR UPDATE OF student_id, institution_id
  ON exam_student_assignments
  FOR EACH ROW EXECUTE FUNCTION exam_student_assignments_validate_tenant();

-- --- audience frozen at publish ------------------------------------------------
-- Set by the server exactly when the exam publishes (the same moment
-- `published_at` is stamped): how many students the exam was released to,
-- deduplicated across class rosters and direct assignments. Nullable:
-- pre-publish exams and rows written before this migration carry NULL.
ALTER TABLE exams
  ADD COLUMN IF NOT EXISTS published_to integer
    CONSTRAINT exams_published_to_check CHECK (published_to IS NULL OR published_to >= 0);

-- --- Row-level security: identical posture to 0001–0011 — deny-by-default
-- for browser-reachable roles; only the server-side service-role client (used
-- by lib/data/exams.ts behind a trusted institution_id filter) may touch
-- this table. Assignment rows are the access grant delivery (prompts 22–23)
-- checks — no browser role ever reads or writes them directly (AGENTS.md §5).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE exam_student_assignments ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE exam_student_assignments FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON exam_student_assignments FROM anon, authenticated';
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON exam_student_assignments TO service_role;
