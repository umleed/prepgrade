-- ---------------------------------------------------------------------------
-- PrepGrade — 0018 platform usage time series (super-admin operational view)
--
-- Scope: ONE read-only aggregate function backing the /platform/usage trend
-- charts. It answers "how many rows were created per UTC calendar bucket"
-- for the five sources that genuinely exist in the schema today:
--   * institutions        (created_at)  — tenant registrations
--   * profiles            (created_at)  — platform account registrations
--   * questions           (created_at)  — question-bank growth (all statuses;
--                                         rows are archived, never deleted, so
--                                         creation counts stay truthful)
--   * exams               (created_at)  — assessments created (0010)
--   * exam_attempts       (created_at)  — attempts STARTED (0013)
--
-- WHY A SQL FUNCTION instead of client-side counting:
--   PostgREST returns at most 1000 rows per request by default, so pulling
--   timestamps and bucketing in the app would SILENTLY TRUNCATE large tables
--   and draw a wrong chart. Aggregating in the database returns ≤ (buckets ×
--   sources) rows and keeps the picture correct at any data volume. The RPC
--   precedent in this schema is students_update_with_class_history (0004).
--
-- TIME ZONE (data-correctness rule): every bucket is computed as
--   date_trunc(<granularity>, created_at AT TIME ZONE 'UTC')::date
-- so a bucket is a UTC calendar day / ISO Monday week / calendar month
-- regardless of the session TimeZone. The application layer (lib/platform-
-- usage.ts) builds the matching contiguous bucket series and displays "UTC".
--
-- TENANT SEMANTICS: p_institution_id IS NULL = platform-wide (the legitimate
-- cross-tenant read of the super-admin area). When set, only tables carrying
-- an institution_id column are filtered; `profiles` has no tenant column, so
-- the accounts series is intentionally EMPTY for an institution-filtered call
-- — the app drops that series and says why, rather than showing a platform
-- total mislabelled as one institution's figure.
--
-- SECURITY (AGENTS.md §5/§7): this is a cross-tenant aggregate read and MUST
-- only ever be called behind requireSuperAdmin(). service_role is the only
-- executable role — PUBLIC/anon/authenticated are explicitly revoked, so no
-- browser-facing role can run it even by guessing the name. Counts only: no
-- personal data leaves the tables. STABLE + no writes; it cannot mutate
-- anything, and the append-only audit posture is untouched.
--
-- PERFORMANCE: per-bucket GROUP BY over the whole window with sequential
-- scans on the created_at predicates (existing indexes are tenant-leading).
-- Acceptable at pilot volume; a platform-wide created_at index per table can
-- be added when row counts justify it — noted, not guessed.
--
-- Apply via `supabase db push` or the SQL editor. Idempotent (OR REPLACE).
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS platform_usage_time_series(timestamptz, timestamptz, text, uuid);
-- No stored state — safe to drop; the usage screen then renders its honest
-- "time series not available in this environment" state (function missing →
-- unavailable, never zero).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform_usage_time_series(
  p_from timestamptz,           -- inclusive window start
  p_to timestamptz,             -- exclusive window end
  p_granularity text,           -- 'day' | 'week' | 'month'
  p_institution_id uuid         -- NULL = platform-wide
)
RETURNS TABLE (
  source        text,
  bucket_start  date,           -- UTC calendar bucket start (day / Monday / 1st)
  event_count   bigint
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_gran text := lower(btrim(coalesce(p_granularity, '')));
BEGIN
  -- Fail closed on nonsense input: an unclamped caller gets an error, not a
  -- quietly-wrong chart.
  IF v_gran NOT IN ('day','week','month') THEN
    RAISE EXCEPTION 'platform_usage_time_series: p_granularity must be day, week or month (got %)', p_granularity
      USING ERRCODE = '22023';  -- invalid_parameter_value
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'platform_usage_time_series: p_from must be a timestamp before p_to'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT 'institutions'::text,
           date_trunc(v_gran, t.created_at AT TIME ZONE 'UTC')::date,
           count(*)
    FROM institutions t
    WHERE t.created_at >= p_from AND t.created_at < p_to
      AND (p_institution_id IS NULL OR t.id = p_institution_id)
    GROUP BY 2;

  RETURN QUERY
    SELECT 'accounts'::text,
           date_trunc(v_gran, t.created_at AT TIME ZONE 'UTC')::date,
           count(*)
    FROM profiles t
    -- No tenant column on profiles: platform-wide only (see header).
    WHERE p_institution_id IS NULL
      AND t.created_at >= p_from AND t.created_at < p_to
    GROUP BY 2;

  RETURN QUERY
    SELECT 'questions'::text,
           date_trunc(v_gran, t.created_at AT TIME ZONE 'UTC')::date,
           count(*)
    FROM questions t
    WHERE t.created_at >= p_from AND t.created_at < p_to
      AND (p_institution_id IS NULL OR t.institution_id = p_institution_id)
    GROUP BY 2;

  RETURN QUERY
    SELECT 'exams'::text,
           date_trunc(v_gran, t.created_at AT TIME ZONE 'UTC')::date,
           count(*)
    FROM exams t
    WHERE t.created_at >= p_from AND t.created_at < p_to
      AND (p_institution_id IS NULL OR t.institution_id = p_institution_id)
    GROUP BY 2;

  RETURN QUERY
    SELECT 'exam_attempts'::text,
           date_trunc(v_gran, t.created_at AT TIME ZONE 'UTC')::date,
           count(*)
    FROM exam_attempts t
    WHERE t.created_at >= p_from AND t.created_at < p_to
      AND (p_institution_id IS NULL OR t.institution_id = p_institution_id)
    GROUP BY 2;
END;
$$;

-- Super-admin-only by construction: the app calls this exclusively through
-- the service-role client behind requireSuperAdmin(). No browser role may
-- execute it.
REVOKE ALL ON FUNCTION platform_usage_time_series(timestamptz, timestamptz, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION platform_usage_time_series(timestamptz, timestamptz, text, uuid)
  TO service_role;
