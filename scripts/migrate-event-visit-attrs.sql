-- Seekigo Phase 4C-1: event visit / decision attributes
--
-- 実行: Supabase SQL Editor に貼り付けて実行（このファイル自体は自動実行しない）
-- 方針:
-- - 既存行は壊さない（DEFAULT で既存を強制しない。nullable / unknown 許容）
-- - AI 推測だけで確定値を入れない前提のスキーマ
-- - reaction signals とは別（family_friendly 等はイベント属性）
-- - is_free / is_indoor / is_kids は既存。本 migration はそれらを置き換えない

-- ─── 料金 ─────────────────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS price_min integer
    CHECK (price_min IS NULL OR price_min >= 0);

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS price_max integer
    CHECK (price_max IS NULL OR price_max >= 0);

COMMENT ON COLUMN public.events.price_min IS
  'Lower bound price in JPY. 0 with is_free=true for free events. null if unknown.';
COMMENT ON COLUMN public.events.price_max IS
  'Upper bound price in JPY. null if unknown.';

-- is_free は既存 boolean nullable を維持

-- ─── 予約 ─────────────────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS reservation_status text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_reservation_status_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_reservation_status_check
  CHECK (
    reservation_status IS NULL
    OR reservation_status IN (
      'required',
      'recommended',
      'not_required',
      'unknown'
    )
  );

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS reservation_url text;

COMMENT ON COLUMN public.events.reservation_status IS
  'required | recommended | not_required | unknown | null';
COMMENT ON COLUMN public.events.reservation_url IS
  'Optional booking / ticket URL. Not required for display.';

-- ─── アクセス ─────────────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS nearest_station text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS access_text text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS walk_minutes integer
    CHECK (walk_minutes IS NULL OR walk_minutes >= 0);

COMMENT ON COLUMN public.events.nearest_station IS
  'Representative nearest station (v1: one station).';
COMMENT ON COLUMN public.events.access_text IS
  'Human-readable access note (JA).';
COMMENT ON COLUMN public.events.walk_minutes IS
  'Approximate walk minutes from nearest_station. null if unknown.';

-- ─── MAP（geocoding は別フェーズ） ────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS latitude numeric;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS longitude numeric;

COMMENT ON COLUMN public.events.latitude IS
  'WGS84 latitude. Filled later via geocoding; not required now.';
COMMENT ON COLUMN public.events.longitude IS
  'WGS84 longitude. Filled later via geocoding; not required now.';

-- ─── venue environment ────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS venue_type text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_venue_type_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_venue_type_check
  CHECK (
    venue_type IS NULL
    OR venue_type IN ('indoor', 'outdoor', 'mixed', 'unknown')
  );

COMMENT ON COLUMN public.events.venue_type IS
  'indoor | outdoor | mixed | unknown | null. Separate from legacy is_indoor boolean.';

-- ─── suitability（イベント属性。reaction signals とは別） ─────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS family_friendly text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS date_friendly text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS solo_friendly text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS rain_friendly text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_family_friendly_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_family_friendly_check
  CHECK (
    family_friendly IS NULL
    OR family_friendly IN ('yes', 'no', 'unknown')
  );

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_date_friendly_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_date_friendly_check
  CHECK (
    date_friendly IS NULL
    OR date_friendly IN ('yes', 'no', 'unknown')
  );

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_solo_friendly_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_solo_friendly_check
  CHECK (
    solo_friendly IS NULL
    OR solo_friendly IN ('yes', 'no', 'unknown')
  );

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_rain_friendly_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_rain_friendly_check
  CHECK (
    rain_friendly IS NULL
    OR rain_friendly IN ('yes', 'no', 'unknown')
  );

COMMENT ON COLUMN public.events.family_friendly IS
  'Event attribute yes|no|unknown|null. Not SNS reaction signal. Do not set from X alone.';
COMMENT ON COLUMN public.events.date_friendly IS
  'Event attribute yes|no|unknown|null. Separate from reaction_summary.date.';
COMMENT ON COLUMN public.events.solo_friendly IS
  'Event attribute yes|no|unknown|null. Separate from reaction_summary.solo.';
COMMENT ON COLUMN public.events.rain_friendly IS
  'Event attribute yes|no|unknown|null. Separate from reaction_summary.rain.';

-- ─── 年齢メモ ─────────────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS age_note text;

COMMENT ON COLUMN public.events.age_note IS
  'Free-text age guidance from official sources. Do not invent numeric ages via AI.';

-- ─── 所要時間 ─────────────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS duration_minutes_min integer
    CHECK (duration_minutes_min IS NULL OR duration_minutes_min >= 0);

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS duration_minutes_max integer
    CHECK (duration_minutes_max IS NULL OR duration_minutes_max >= 0);

COMMENT ON COLUMN public.events.duration_minutes_min IS
  'Suggested visit duration lower bound (minutes). null if unknown.';
COMMENT ON COLUMN public.events.duration_minutes_max IS
  'Suggested visit duration upper bound (minutes). null if unknown.';

-- ─── parking ──────────────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS parking_status text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_parking_status_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_parking_status_check
  CHECK (
    parking_status IS NULL
    OR parking_status IN (
      'available',
      'not_available',
      'nearby',
      'unknown'
    )
  );

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS parking_text text;

COMMENT ON COLUMN public.events.parking_status IS
  'available | not_available | nearby | unknown | null';
COMMENT ON COLUMN public.events.parking_text IS
  'Optional parking note (JA).';

-- ─── optional consistency: price_min <= price_max when both set ─

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_price_min_max_order;

ALTER TABLE public.events
  ADD CONSTRAINT events_price_min_max_order
  CHECK (
    price_min IS NULL
    OR price_max IS NULL
    OR price_min <= price_max
  );

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_duration_min_max_order;

ALTER TABLE public.events
  ADD CONSTRAINT events_duration_min_max_order
  CHECK (
    duration_minutes_min IS NULL
    OR duration_minutes_max IS NULL
    OR duration_minutes_min <= duration_minutes_max
  );
