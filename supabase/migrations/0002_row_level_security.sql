-- ---------------------------------------------------------------------------
-- PrepGrade — 0002 row-level security (deny-by-default for client roles)
--
-- ACCESS MODEL: the application reaches these tables ONLY through a server-side
-- Supabase service-role client (lib/supabase/server.ts). `service_role` has the
-- BYPASSRLS attribute, so it reads/writes every row; the DATA LAYER is
-- therefore responsible for always filtering mutations and queries by the
-- trusted `institution_id` from `AuthPrincipal` (see lib/data/students.ts) —
-- this is the "server authorization" half of AGENTS.md §5's "server AND
-- database layer where supported."
--
-- WHAT RLS GUARANTEES HERE: the browser-facing `anon` and `authenticated`
-- Postgres roles are denied ALL row access to every tenant table. Even if the
-- public anon key were used to query Supabase directly from a browser, no
-- student, membership, class, or institution row could be read or written.
-- Enabling RLS with zero permissive policies for those roles is exactly this
-- deny-by-default state; the explicit REVOKEs make the intent unmistakable.
--
-- FUTURE HARDENING (documented, not yet wired): once a request-scoped tenant
-- claim is available to PostgREST (Clerk → Supabase JWT custom claims, or a
-- `SET LOCAL app.current_institution_id` connection), permissive policies can
-- be added to let a non-bypass role see only its own institution's rows. Until
-- then, direct client access stays closed and isolation is enforced server-side.
--
-- ROLLBACK: `ALTER TABLE … DISABLE ROW LEVEL SECURITY` and
--   GRANT SELECT, INSERT, UPDATE, DELETE ON <tables> TO anon, authenticated;
--   restores the pre-migration grants. (Re-enabling deny-by-default is the safe
--   direction; loosening grants is only meaningful in a throwaway env.)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'institutions',
    'profiles',
    'institution_memberships',
    'academic_sessions',
    'classes',
    'students'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Fail-closed: force RLS even for the table owner, so a misconfigured role
    -- cannot accidentally see everything.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Remove any default wide-open access for browser-reachable roles.
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- service_role is the only role allowed through, and it bypasses RLS by
-- Supabase default. Grant it explicitly so the app's data layer has access even
-- if a project template has trimmed default grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  institutions,
  profiles,
  institution_memberships,
  academic_sessions,
  classes,
  students
TO service_role;
