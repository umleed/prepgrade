-- ---------------------------------------------------------------------------
-- PrepGrade — 0008 institution lifecycle & directory fields (prompt 32)
--
-- Scope: the smallest schema change that lets the platform-admin institution
-- directory (prompt 32) show an honest operational status and offer ONLY the
-- approved status transitions, with every change audited in
-- platform_audit_log (0007). Prompt 31 shipped the read-only directory and
-- deliberately noted that the institutions table had no lifecycle column, so
-- there was nothing truthful to display or change; this migration adds it.
--
--   * status           — operational status the platform team controls for
--                        support: 'active' (normal), 'suspended' (temporarily
--                        disabled), 'archived' (retired, kept for history).
--                        Archive-never-delete (AGENTS.md §6): a suspended or
--                        archived institution is still fully queryable; no
--                        row is destroyed and no tenant data is touched.
--   * institution_type — a coarse, non-personal descriptor for the directory
--                        list ("what kind of tenant is this"). Nullable with
--                        no default: institutions created before this change
--                        have no recorded type and MUST render as "Not set",
--                        never be back-filled with a guess.
--
-- NOT in scope (deliberately): location, contact email/phone, subscription
-- plan, billing, or usage charts from the design reference. None of those
-- columns or tables exist, and billing/subscription is future scope (prompt 32
-- Implementation Notes). Adding them here would be fabricating data.
--
-- TENANT BOUNDARY (AGENTS.md §5): these columns describe the tenant record
-- itself, not any learner. They are written ONLY through the platform
-- (SUPER_ADMIN) server action, which enforces the transition rules and audits
-- the change. No membership, student, or personal row is read or altered.
--
-- Apply via Supabase SQL editor or `supabase db push`. Idempotent (ADD COLUMN
-- IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) so re-running during a pilot is
-- safe. Existing rows keep operating: status back-fills to 'active' via the
-- column default, institution_type stays NULL until a human sets it.
--
-- RLS: institutions is already protected by 0002 (deny-by-default for
-- anon/authenticated; the app reaches it only via the service-role client in
-- lib/data/*). Adding columns changes no grants, so nothing to re-wire here —
-- the server-side SUPER_ADMIN guard remains the enforcement point.
--
-- ROLLBACK (destructive — drops the two columns and their index; do it only
-- where the data can be rebuilt):
--   DROP INDEX IF EXISTS institutions_status_idx;
--   ALTER TABLE institutions DROP COLUMN IF EXISTS institution_type,
--                            DROP COLUMN IF EXISTS status;
-- ---------------------------------------------------------------------------

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived'));

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS institution_type text
    CHECK (
      institution_type IS NULL
      OR institution_type IN ('school', 'tutorial_centre', 'cbt_centre')
    );

-- Support workflows filter and sort by operational status; keep the CHECK
-- scan cheap on a growing directory.
CREATE INDEX IF NOT EXISTS institutions_status_idx ON institutions (status);
