-- ---------------------------------------------------------------------------
-- PrepGrade — 0004 classes and academic sessions (prompt 13)
--
-- Scope: complete the assessment-organisation shape that 0001 sketched. No
-- new primary tables are needed — `academic_sessions` and `classes` already
-- exist — so this migration only adds what the class/session workflows
-- require:
--
--   1. `status` on both tables (active ⇄ archived). Archiving is the
--      non-destructive removal: prompts 15–24 hang exams, attempts and results
--      off `classes.id`, so a class that has been used can never be hard-
--      deleted without corrupting historical results (AGENTS.md §6). The app
--      therefore only ever offers archive, never delete.
--
--   2. Per-tenant archive-name index swap for CLASSES only. The 0001 table-level
--      UNIQUE(institution_id, name) would permanently block reusing a name
--      once its class is archived. Mirroring `students_code_active_uidx`, the
--      class uniqueness is narrowed to live rows so an archived class frees its
--      name — while two live classes with the same name still fail (23505).
--      ACADEMIC SESSIONS keep their original 0001 institution-wide UNIQUE
--      (name) unchanged; a redundant partial session index is NOT created (the
--      lifecycle there is archive-for-reading, not name-recycling — see below).
--
--   3. `student_class_history`: the record that lets a student MOVE CLASSES
--      without corrupting history. One row is appended, atomically with the
--      transfer, by the `students_update_with_class_history` function below —
--      it records the class the student WAS in (the class being LEFT), never
--      the student's new class. The table is made genuinely APPEND-ONLY at the
--      privilege level (a BEFORE UPDATE/DELETE trigger + REVOKE of UPDATE and
--      DELETE from service_role), because RLS cannot be assumed to protect the
--      service-role connection the data layer runs on (it bypasses RLS).
--
--   4. TENANT-AWARE COMPOSITE FOREIGN KEYS. The plain FKs from 0001 only prove
--      the referenced row EXISTS, not that it shares the referencing row's
--      institution — a cross-tenant session_id or class_id passed them (the
--      finding recorded in 0003). We add (institution_id, id) UNIQUEs on the
--      parents and repoint class→session and student→class at the composite,
--      so a cross-institution relationship is refused BY THE DATABASE even if
--      an application check is ever missed. The data-layer tenant checks stay
--      (defence in depth), but are no longer the ONLY barrier.
--
-- Apply after 0001, 0002 and 0003. Idempotent via IF NOT EXISTS; constraint
-- drops/adds are guarded by DO blocks so a re-run is a no-op.
--
-- MIGRATION DATA NOTE: adding the composite FKs validates EXISTING rows. On a
--   fresh/throwaway database this is trivially satisfied. On a database that
--   already contains a cross-tenant class→session or student→class link (which
--   the old single-column FK allowed), the ALTER will raise 23503 and the
--   migration must be run only after those rows are corrected. This is
--   intentional: the schema refuses to adopt a state the tenant model forbids.
--
-- ROLLBACK implications:
--   DROP FUNCTION students_update_with_class_history(...);
--   DROP TRIGGER student_class_history_append_only ON student_class_history;
--   DROP TABLE student_class_history;
--   ALTER TABLE classes DROP CONSTRAINT students_class_institution_fk /
--     classes_academic_session_institution_fk; re-add the 0001 single-column
--     FKs; DROP the (institution_id, id) UNIQUEs; ALTER TABLE classes/
--     academic_sessions DROP COLUMN status; restore classes_institution_id_name_key.
--   Destructive once rows exist — the status columns and history rows carry
--   data that cannot be regenerated.
-- ---------------------------------------------------------------------------

-- --- Academic sessions: archive support ------------------------------------
-- `archived` sessions stay readable for historical reporting, but the data
-- layer refuses to attach NEW classes to them (lib/data/classes.ts).
ALTER TABLE academic_sessions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived'));

CREATE INDEX IF NOT EXISTS academic_sessions_status_idx
  ON academic_sessions (status);

-- Academic-session uniqueness is LEFT EXACTLY AS 0001 DEFINED IT: the
-- institution-wide UNIQUE (institution_id, name). No partial name index is
-- added here. A session's archive is a read-only retirement for reporting, not
-- a name-recycling mechanism, so the original constraint is the correct one and
-- a second partial index over the same columns would be redundant. If a future
-- requirement needs archived-session name reuse, that is a deliberate change to
-- this constraint, not an accidental one.

DROP TRIGGER IF EXISTS academic_sessions_set_updated_at ON academic_sessions;
CREATE TRIGGER academic_sessions_set_updated_at
  BEFORE UPDATE ON academic_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Classes: archive support ----------------------------------------------
ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived'));

CREATE INDEX IF NOT EXISTS classes_status_idx ON classes (status);

-- Replace the 0001 table-level UNIQUE with the live-rows-only form. Guarded so
-- re-running after the drop is harmless.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'classes_institution_id_name_key'
      AND conrelid = 'classes'::regclass
  ) THEN
    ALTER TABLE classes DROP CONSTRAINT classes_institution_id_name_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS classes_name_active_uidx
  ON classes (institution_id, lower(name))
  WHERE status <> 'archived';

DROP TRIGGER IF EXISTS classes_set_updated_at ON classes;
CREATE TRIGGER classes_set_updated_at
  BEFORE UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Tenant-aware composite FK substrate -----------------------------------
-- The parents must expose UNIQUE(institution_id, id) before a composite FK can
-- reference them. Added idempotently; a fresh project has no violating rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'academic_sessions_institution_id_id_key'
      AND conrelid = 'academic_sessions'::regclass
  ) THEN
    ALTER TABLE academic_sessions
      ADD CONSTRAINT academic_sessions_institution_id_id_key
      UNIQUE (institution_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'classes_institution_id_id_key'
      AND conrelid = 'classes'::regclass
  ) THEN
    ALTER TABLE classes
      ADD CONSTRAINT classes_institution_id_id_key
      UNIQUE (institution_id, id);
  END IF;
END $$;

-- class → session: repoint the single-column FK at the composite so a
-- cross-institution session id is refused by the database. Delete semantics
-- move from SET NULL to NO ACTION because a session is NEVER hard-deleted (the
-- lifecycle is archive-only), so there is no cascade to null out; an attempt to
-- remove a session that still has classes is correctly blocked.
ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_academic_session_id_fkey;
ALTER TABLE classes
  ADD CONSTRAINT classes_academic_session_institution_fk
  FOREIGN KEY (institution_id, academic_session_id)
  REFERENCES academic_sessions (institution_id, id)
  ON DELETE NO ACTION;

-- student → class: same strengthening. A student may only reference a class of
-- their OWN institution. NO ACTION because classes are archived, never deleted.
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_class_id_fkey;
ALTER TABLE students
  ADD CONSTRAINT students_class_institution_fk
  FOREIGN KEY (institution_id, class_id)
  REFERENCES classes (institution_id, id)
  ON DELETE NO ACTION;

-- --- Student ↔ class history: the move-classes-without-corrupting-record ----
-- One row is written each time a student's class assignment changes, recording
-- the class the student WAS in immediately BEFORE the move (`class_id` is the
-- class being LEFT; NULL when they were previously unassigned, in which case
-- there is no past class to preserve and NO row is written). The roster row only
-- holds the current class, so without these rows a mid-year move would silently
-- rewrite the class a student belonged to for every past assessment period.
-- `class_name_snapshot` keeps the label readable after the class is renamed or
-- archived, so a report covering a past period never loses its heading.
--
-- A student may legitimately hold several rows for the same class across
-- different sessions, so there is deliberately no unique constraint: history
-- is append-only, one row per observed change.
CREATE TABLE IF NOT EXISTS student_class_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id    uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id          uuid REFERENCES classes(id) ON DELETE SET NULL,
  class_name_snapshot text,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_class_history_institution_idx
  ON student_class_history (institution_id);
CREATE INDEX IF NOT EXISTS student_class_history_student_idx
  ON student_class_history (student_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS student_class_history_class_idx
  ON student_class_history (class_id, changed_at DESC);

-- APPEND-ONLY, ENFORCED BELOW RLS. The data layer runs on service_role, which
-- BYPASSES row-level security, so RLS policies cannot make this table
-- immutable for the only role that can reach it. Two mechanisms do:
--   * a BEFORE UPDATE/DELETE trigger that raises for ANY role — including the
--     table owner / superuser, who bypasses GRANT but not triggers;
--   * an explicit REVOKE of UPDATE and DELETE from service_role, so ordinary
--     misuse fails on privilege before even reaching the trigger.
-- (The old set_updated_at trigger is intentionally not recreated: there are no
-- legitimate updates to stamp.)
CREATE OR REPLACE FUNCTION forbid_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: UPDATE and DELETE are not permitted', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS student_class_history_set_updated_at ON student_class_history;

DROP TRIGGER IF EXISTS student_class_history_append_only ON student_class_history;
CREATE TRIGGER student_class_history_append_only
  BEFORE UPDATE OR DELETE ON student_class_history
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();

-- --- Atomic class transfer + history write ---------------------------------
-- A transfer and its history row MUST commit or fail together: a step that
-- updated the roster then died before writing history would silently rewrite
-- the student's past. A single SECURITY DEFINER function is one implicit
-- transaction in Postgres, so both statements share one commit. `FOR UPDATE`
-- locks the student row so two concurrent transfers cannot interleave and
-- double-record. Returns FALSE when the student does not exist under the
-- supplied tenant (fail closed — the caller surfaces an honest error rather
-- than a bogus success). Mirrored, and unit-tested, by
-- lib/classes.ts::classHistoryTarget.
CREATE OR REPLACE FUNCTION students_update_with_class_history(
  p_institution_id uuid,
  p_student_id     uuid,
  p_full_name      text,
  p_student_code   text,
  p_class_id       uuid,
  p_status         text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_class uuid;
  v_old_name  text;
BEGIN
  -- Lock the student row and read its CURRENT class, scoped to the tenant so a
  -- foreign id matches nothing (fail closed → FALSE).
  SELECT class_id INTO v_old_class
    FROM students
   WHERE id = p_student_id
     AND institution_id = p_institution_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE students
     SET full_name    = p_full_name,
         student_code = p_student_code,
         class_id     = p_class_id,
         status       = p_status
   WHERE id = p_student_id
     AND institution_id = p_institution_id;

  -- Record the class being LEFT — only on a real change away from a real class.
  IF v_old_class IS NOT NULL AND v_old_class IS DISTINCT FROM p_class_id THEN
    SELECT name INTO v_old_name
      FROM classes
     WHERE id = v_old_class
       AND institution_id = p_institution_id;

    INSERT INTO student_class_history (
      institution_id, student_id, class_id, class_name_snapshot
    )
    VALUES (
      p_institution_id, p_student_id, v_old_class, v_old_name
    );
  END IF;

  RETURN TRUE;
END;
$$;

-- --- Row-level security: identical posture to 0002/0003 — deny-by-default ---
-- for browser-reachable roles; only the server-side service-role client (which
-- the data layer uses with a trusted institution_id filter) may touch these.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'academic_sessions',
    'classes',
    'student_class_history'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- service_role owns the read/write surface. History is INSERT/SELECT only for
-- the application role — UPDATE and DELETE are revoked so the only path to a
-- history row is an append (the trigger is the belt-and-braces backstop that
-- also stops the owner).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  academic_sessions,
  classes
TO service_role;

GRANT SELECT, INSERT ON student_class_history TO service_role;
REVOKE UPDATE, DELETE ON student_class_history FROM service_role;

-- The transfer function is callable only by the server role; no browser role
-- reaches it (the data layer is the sole caller).
REVOKE ALL ON FUNCTION students_update_with_class_history(uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION students_update_with_class_history(uuid, uuid, text, text, uuid, text) TO service_role;
