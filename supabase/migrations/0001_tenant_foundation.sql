-- ---------------------------------------------------------------------------
-- PrepGrade — 0001 tenant foundation
--
-- Scope: the MINIMAL multi-tenant foundation that student management (prompt
-- 11) needs. Later prompts add their own tables on top of these (classes are
-- fleshed out in prompt 13; questions/exams/attempts/results in prompts 15–24).
-- This migration deliberately does NOT create exam or content tables.
--
-- Identity note: authentication is Clerk (see lib/auth/context.ts), so the
-- stable human identity key is Clerk's user id string (e.g. "user_2abc…"), NOT
-- a Supabase `auth.users` uuid. `profiles.id` therefore stores the Clerk user id
-- and memberships/students reference it as text. This keeps the DB consistent
-- with `AuthPrincipal.userId`, which is what `checkResourceAccess` compares
-- ownership against (AGENTS.md §5).
--
-- Apply (Supabase SQL editor or `supabase db push`). Idempotent via IF NOT
-- EXISTS so re-running during a pilot is safe.
--
-- ROLLBACK implications:
--   DROP TABLE students, classes, academic_sessions, institution_memberships,
--   profiles, institutions;  (children first — FKs are ON DELETE CASCADE, but a
--   plain DROP must still go leaf → root). DROP TRIGGER / FUNCTION below.
--   Destructive and irreversible once rows exist; roll back only in an
--   environment where the data can be rebuilt.
-- ---------------------------------------------------------------------------

-- Lifecycle helper: keep updated_at current on every write.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- --- Institutions (the tenant; "institution" is the generic term in this
--     product — schools, tutorial centres, and CBT centres are all one kind). --
CREATE TABLE IF NOT EXISTS institutions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS institutions_set_updated_at ON institutions;
CREATE TRIGGER institutions_set_updated_at
  BEFORE UPDATE ON institutions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Profiles: server-written mirror of a Clerk account. Prompt 08 provisions
--     these; the auth stack can later read membership here instead of Clerk
--     privateMetadata without changing the returned AuthPrincipal shape. -------
CREATE TABLE IF NOT EXISTS profiles (
  id            text PRIMARY KEY,           -- Clerk user id
  email         text,                        -- presentation/lookup only
  full_name     text,                        -- presentation only
  account_type  text,                        -- registration intent: student/teacher/school/cbt_centre
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles (lower(email));

DROP TRIGGER IF EXISTS profiles_set_updated_at ON profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Institution memberships: the trusted tenant ↔ role ↔ user join. This is
--     the table `lib/auth/context.ts` will read for authorization once it lands,
--     replacing the privateMetadata read while keeping hasMembership semantics. --
CREATE TABLE IF NOT EXISTS institution_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN
                    ('SUPER_ADMIN','INSTITUTION_ADMIN','TEACHER','STUDENT')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, user_id)
);

CREATE INDEX IF NOT EXISTS institution_memberships_institution_idx
  ON institution_memberships (institution_id);
CREATE INDEX IF NOT EXISTS institution_memberships_user_idx
  ON institution_memberships (user_id);

DROP TRIGGER IF EXISTS institution_memberships_set_updated_at ON institution_memberships;
CREATE TRIGGER institution_memberships_set_updated_at
  BEFORE UPDATE ON institution_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Academic sessions (e.g. "2025/2026"): classes hang off these. ----------
CREATE TABLE IF NOT EXISTS academic_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, name)
);

CREATE INDEX IF NOT EXISTS academic_sessions_institution_idx
  ON academic_sessions (institution_id);

DROP TRIGGER IF EXISTS academic_sessions_set_updated_at ON academic_sessions;
CREATE TRIGGER academic_sessions_set_updated_at
  BEFORE UPDATE ON academic_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Classes: students are assigned here. Basic shape only; the class UX and
--     session wiring complete in prompt 13. ----------------------------------
CREATE TABLE IF NOT EXISTS classes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id      uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  academic_session_id uuid REFERENCES academic_sessions(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, name)
);

CREATE INDEX IF NOT EXISTS classes_institution_idx ON classes (institution_id);
CREATE INDEX IF NOT EXISTS classes_session_idx     ON classes (academic_session_id);

DROP TRIGGER IF EXISTS classes_set_updated_at ON classes;
CREATE TRIGGER classes_set_updated_at
  BEFORE UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Students: institution roster records (prompt 11). `profile_id` links a
--     claimed login account when one exists; a student can be enrolled before
--     they sign up, so it is nullable. `student_code` is unique per institution.
--     Personal data is minimised (AGENTS.md §7): only name, code, class, status. --
CREATE TABLE IF NOT EXISTS students (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id  uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  profile_id      text REFERENCES profiles(id) ON DELETE SET NULL,
  student_code    text NOT NULL CHECK (char_length(trim(student_code)) BETWEEN 1 AND 40),
  full_name       text NOT NULL CHECK (char_length(trim(full_name)) BETWEEN 1 AND 120),
  class_id        uuid REFERENCES classes(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,          -- soft delete; access deactivation uses status
  UNIQUE (institution_id, student_code)
);

CREATE INDEX IF NOT EXISTS students_institution_idx ON students (institution_id);
CREATE INDEX IF NOT EXISTS students_class_idx        ON students (class_id);
CREATE INDEX IF NOT EXISTS students_status_idx       ON students (status);
CREATE INDEX IF NOT EXISTS students_name_search_idx  ON students (lower(full_name));
-- Keep the code unique only among live rows so a soft-deleted code can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS students_code_active_uidx
  ON students (institution_id, lower(student_code))
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS students_set_updated_at ON students;
CREATE TRIGGER students_set_updated_at
  BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
