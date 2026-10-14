-- ---------------------------------------------------------------------------
-- PrepGrade — 0003 teacher management (prompt 12)
--
-- Scope: the institution teacher roster and the teacher ↔ class assignment
-- join the directory needs. Teachers are institution-scoped roster records
-- exactly like students (0001), plus a link to the trusted membership tables:
--   * `teachers.profile_id` mirrors `students.profile_id` — nullable because a
--     teacher can be invited before they have a Clerk account; it is filled by
--     the trusted server-side grant flow (lib/data/teachers.ts), never by a
--     browser request.
--   * `teacher_class_assignments` is the scope source that prompt 13's
--     `CallerScope.teachingClassIds` and `checkResourceAccess` read. The
--     teacher workspace itself is prompt 26; this table only records scope.
--
-- Roles are NOT stored here. The authoritative role lives in
-- `institution_memberships` (0001) and, until the DB-backed auth read lands,
-- in Clerk `privateMetadata` written server-side. The role a grant writes is
-- hardcoded TEACHER in code — this schema has no path for an admin to plant a
-- SUPER_ADMIN/INSTITUTION_ADMIN through the teacher flow.
--
-- Personal data is minimised (AGENTS.md §7): name, work email, employee code,
-- status, class scope — nothing else.
--
-- Apply after 0001 and 0002. Idempotent via IF NOT EXISTS.
--
-- ROLLBACK implications:
--   DROP TABLE teacher_class_assignments, teachers;  (children first)
--   then the RLS statements at the bottom are undone by
--   ALTER TABLE … DISABLE ROW LEVEL SECURITY. Destructive once rows exist.
-- ---------------------------------------------------------------------------

-- --- Teachers: institution roster records (prompt 12). -----------------------
-- status lifecycle: invited → active ⇄ inactive.
--   invited  = on the roster, no login access granted yet (pending acceptance)
--   active   = linked account with TEACHER membership/access granted
--   inactive = access deactivated (reversible); history is preserved
CREATE TABLE IF NOT EXISTS teachers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  profile_id     text REFERENCES profiles(id) ON DELETE SET NULL,
  email          text NOT NULL CHECK (char_length(trim(email)) BETWEEN 3 AND 160),
  employee_code  text NOT NULL CHECK (char_length(trim(employee_code)) BETWEEN 1 AND 40),
  full_name      text NOT NULL CHECK (char_length(trim(full_name)) BETWEEN 1 AND 120),
  status         text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','inactive')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,          -- soft delete; access deactivation uses status
  UNIQUE (institution_id, employee_code)
);

CREATE INDEX IF NOT EXISTS teachers_institution_idx ON teachers (institution_id);
CREATE INDEX IF NOT EXISTS teachers_status_idx      ON teachers (status);
CREATE INDEX IF NOT EXISTS teachers_name_search_idx ON teachers (lower(full_name));
-- Work email is the account-linking key: unique per institution among live
-- rows (partial so a soft-deleted row frees the address), case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS teachers_email_active_uidx
  ON teachers (institution_id, lower(email))
  WHERE deleted_at IS NULL;
-- Keep the employee code unique only among live rows so a soft-deleted code
-- can be reused (mirrors students_code_active_uidx).
CREATE UNIQUE INDEX IF NOT EXISTS teachers_code_active_uidx
  ON teachers (institution_id, lower(employee_code))
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS teachers_set_updated_at ON teachers;
CREATE TRIGGER teachers_set_updated_at
  BEFORE UPDATE ON teachers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Teacher ↔ class assignments: the teaching scope (prompt 12 writes, ------
-- prompt 13/26 consume). NOTE (same finding as the student harness): the FKs
-- alone do NOT enforce that teacher and class share an institution — the DATA
-- LAYER (lib/data/teachers.ts::replaceTeacherClassAssignments) validates both
-- ids against the caller's tenant before writing. That check is load-bearing.
CREATE TABLE IF NOT EXISTS teacher_class_assignments (
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (teacher_id, class_id)
);

CREATE INDEX IF NOT EXISTS teacher_class_assignments_class_idx
  ON teacher_class_assignments (class_id);

-- --- Row-level security: identical posture to 0002 — deny-by-default for -----
-- browser-reachable roles; only the server-side service-role client (which the
-- data layer uses with a trusted institution_id filter) may touch these rows.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'teachers',
    'teacher_class_assignments'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  teachers,
  teacher_class_assignments
TO service_role;
