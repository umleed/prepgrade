-- ---------------------------------------------------------------------------
-- PrepGrade — 0007 platform audit log (prompt 31, minimal foundation)
--
-- Scope: the smallest reliable audit foundation for PLATFORM-level (super
-- admin) operations. There is no general audit-log table in the schema yet,
-- and prompt 33 (audit logs & system health) will build the full operational
-- surface on top of this one. This migration deliberately records only:
--   * who acted  (actor_id / actor_role — resolved server-side, never
--     client-supplied; 'unassigned' covers a denied visitor whose trusted
--     principal had no role, and 'unknown' covers an anonymous probe),
--   * what they tried (action), against what (target_type / target_id),
--   * whether it was allowed or denied (outcome),
--   * when (created_at).
--
-- PRIVACY (AGENTS.md §7): detail is a short, bounded JSON summary. Application
-- code must never place passwords, authentication secrets, answer keys, or
-- unnecessary personal data in it — the bounds here are the backstop, not the
-- primary rule.
--
-- IMMUTABILITY: ordinary users are prevented from modifying or deleting audit
-- records on three layers:
--   1. RLS is enabled + FORCED and there are ZERO permissive policies, and
--      all grants are revoked from the browser-facing anon/authenticated
--      roles (same deny-by-default model as 0002).
--   2. service_role is granted only SELECT and INSERT — no UPDATE/DELETE is
--      even possible for the key the application uses.
--   3. An append-only trigger refuses UPDATE and DELETE for EVERY role,
--      including superuser/BYPASSRLS, so the table cannot be silently
--      rewritten even by a misconfigured migration runner.
--
-- Apply via Supabase SQL editor or `supabase db push`. Idempotent via IF NOT
-- EXISTS so re-running during a pilot is safe.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS platform_audit_log_append_only ON platform_audit_log;
--   DROP FUNCTION IF EXISTS platform_audit_log_reject_mutation();
--   DROP TABLE IF EXISTS platform_audit_log;
--   Destructive and irreversible once rows exist — audit history is exactly
--   the data you do not throw away. Roll back only in a throwaway env.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Clerk user id of the acting account (same identity key as profiles.id),
  -- or 'unknown' for an anonymous request that was denied at the gate.
  actor_id     text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 100),
  -- Trusted role at the moment of the action — recorded verbatim from the
  -- server-resolved principal, including 'unassigned' for a role-less account.
  actor_role   text NOT NULL CHECK (actor_role IN
                 ('SUPER_ADMIN','INSTITUTION_ADMIN','TEACHER','STUDENT','unassigned','unknown')),
  -- Named platform action, e.g. 'platform.access_denied'. The application
  -- catalog (lib/audit/platform.ts) is the source of truth for names.
  action       text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  -- Resource the action targeted. Both nullable because some actions
  -- (e.g. a denied area entry) have no single row to point at.
  target_type  text CHECK (target_type IS NULL OR char_length(trim(target_type)) BETWEEN 1 AND 60),
  target_id    text CHECK (target_id IS NULL OR char_length(target_id) <= 100),
  -- 'success' | 'failed' | 'denied' — the outcome the server enforced.
  outcome      text NOT NULL CHECK (outcome IN ('success','failed','denied')),
  -- Short JSON summary (never secrets/answer keys — see header). Bounded so a
  -- caller cannot smuggle a document into an audit row.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000)
);

CREATE INDEX IF NOT EXISTS platform_audit_log_created_idx
  ON platform_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_log_actor_idx
  ON platform_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_log_action_idx
  ON platform_audit_log (action, created_at DESC);

-- Append-only enforcement: refuse UPDATE/DELETE for every role, including
-- table owner and BYPASSRLS roles. INSERT and SELECT are unaffected.
CREATE OR REPLACE FUNCTION platform_audit_log_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only; % is not permitted', TG_OP
    USING ERRCODE = '42809';  -- insufficient_privilege
END;
$$;

DROP TRIGGER IF EXISTS platform_audit_log_append_only ON platform_audit_log;
CREATE TRIGGER platform_audit_log_append_only
  BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_reject_mutation();

-- --- Deny-by-default for browser roles (mirrors 0002) -----------------------
ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_audit_log FROM anon, authenticated;

-- service_role is the only writer/reader the app uses — and note that
-- service_role BYPASSES RLS, so this explicit, narrow grant (SELECT + INSERT
-- only, never UPDATE/DELETE) is what keeps the append-only promise real for
-- the application key. The trigger above covers everyone else.
GRANT SELECT, INSERT ON platform_audit_log TO service_role;
