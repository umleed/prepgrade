-- ---------------------------------------------------------------------------
-- PrepGrade — 0015 institution registration profile fields (platform add-flow)
--
-- Scope: the smallest schema change that lets an authorised SUPER_ADMIN
-- register a new institution from the platform area with the profile fields
-- the product actually supports: an optional short name/description and a
-- location & contact block (country, state, city, address, contact person,
-- contact email, contact phone). The institutions table previously carried
-- only name + lifecycle columns (0001/0008), so without these columns the
-- registration form would have nowhere honest to store what it collects.
--
--   * every new column is NULLABLE: institutions created before this change
--     (via onboarding/seed) simply have no profile data recorded — the UI
--     renders "Not set", never a guess (same rule as institution_type in 0008).
--   * CHECK bounds mirror the pure validation contract in
--     lib/institutions.ts (validateInstitutionRegistration) so a caller that
--     skips server validation still cannot write an out-of-range value.
--   * contact_email / contact_phone carry a light format CHECK — a backstop
--     for the normalised values the server writes, not a delivery guarantee.
--     No email is sent by this flow (see the completion notes).
--   * institutions_name_unique_idx: duplicate prevention at the database
--     level. Institution names are unique case-insensitively after trimming
--     (lower(btrim(name))), mirroring normalizeInstitutionNameKey() so the
--     server-side pre-check and the constraint agree. Two operators racing on
--     the same name: one inserts, the other gets 23505 and the UI reports the
--     duplicate instead of creating a second tenant.
--     NOTE: creating this index FAILS if existing rows already share a
--     normalised name — resolve any such legacy duplicates before applying.
--
-- NOT in scope (deliberately, none of these systems exist yet):
--   * logo storage — there is no verified Supabase Storage flow in the app,
--     so no logo_url column is added (no dead fields).
--   * subscription plans / entitlements / billing — future phase (prompt 46).
--   * "draft" lifecycle — institutions.status stays the 0008 catalog
--     (active/suspended/archived); a platform-created institution starts
--     'active' because the trusted operator registering it IS the approver.
--   * first-admin membership provisioning and welcome emails — depends on an
--     institution-admin invitation workflow that does not exist; the contact
--     fields below record WHO to invite when that workflow lands.
--
-- PRIVACY (AGENTS.md §7): the contact block is business contact data for the
-- tenant itself (the person the platform already corresponds with), collected
-- deliberately for institution support — it is the minimum that makes a new
-- tenant reachable. It is written and read only through the platform
-- (SUPER_ADMIN) surface; no tenant-member or learner row is touched.
--
-- TENANT ISOLATION: these columns describe the tenant record; they add no
-- cross-tenant read path. The service-role data layer (lib/data/*) remains
-- the only writer, behind the SUPER_ADMIN guard.
--
-- Apply via Supabase SQL editor or `supabase db push`. Idempotent (ADD COLUMN
-- IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS) so re-running during a
-- pilot is safe.
--
-- RLS: institutions is deny-by-default for anon/authenticated (0002) and the
-- app reaches it only via the service-role client; adding columns changes no
-- grants, so nothing to re-wire — the server-side SUPER_ADMIN guard remains
-- the enforcement point.
--
-- ROLLBACK (destructive — drops the profile columns and the uniqueness
-- index; do it only where the data can be rebuilt):
--   DROP INDEX IF EXISTS institutions_name_unique_idx;
--   ALTER TABLE institutions
--     DROP COLUMN IF EXISTS short_name, DROP COLUMN IF EXISTS description,
--     DROP COLUMN IF EXISTS country,   DROP COLUMN IF EXISTS state,
--     DROP COLUMN IF EXISTS city,      DROP COLUMN IF EXISTS address,
--     DROP COLUMN IF EXISTS contact_person, DROP COLUMN IF EXISTS contact_email,
--     DROP COLUMN IF EXISTS contact_phone;
-- ---------------------------------------------------------------------------

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS short_name text
    CHECK (short_name IS NULL OR char_length(btrim(short_name)) BETWEEN 1 AND 40);

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS description text
    CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 500);

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS country text
    CHECK (country IS NULL OR char_length(btrim(country)) BETWEEN 1 AND 60);

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS state text
    CHECK (state IS NULL OR char_length(btrim(state)) BETWEEN 1 AND 60);

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS city text
    CHECK (city IS NULL OR char_length(btrim(city)) BETWEEN 1 AND 80);

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS address text
    CHECK (address IS NULL OR char_length(btrim(address)) BETWEEN 1 AND 200);

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS contact_person text
    CHECK (contact_person IS NULL OR char_length(btrim(contact_person)) BETWEEN 1 AND 120);

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS contact_email text
    CHECK (
      contact_email IS NULL
      OR (
        char_length(btrim(contact_email)) BETWEEN 3 AND 254
        AND contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      )
    );

ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS contact_phone text
    CHECK (
      contact_phone IS NULL
      OR (
        char_length(btrim(contact_phone)) BETWEEN 8 AND 16
        AND contact_phone ~ '^\+?[0-9]{8,15}$'
      )
    );

-- Duplicate prevention: one tenant per normalised (trimmed, case-insensitive)
-- institution name. See the header for the race-condition semantics.
CREATE UNIQUE INDEX IF NOT EXISTS institutions_name_unique_idx
  ON institutions (lower(btrim(name)));
