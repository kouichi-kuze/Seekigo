-- Seekigo: events 画像利用ポリシー用カラム
-- 実行: Supabase SQL Editor に貼り付けて実行（このファイル自体は自動実行しない）
--
-- 方針:
-- - image_url は取得・保持してよい
-- - 公開表示は image_usage_status が licensed / organizer_granted / own のときのみ
-- - sync は published の image_* を自動変更しない

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS image_usage_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS image_credit text,
  ADD COLUMN IF NOT EXISTS image_source text;

-- 既存行の default 適用確認（NOT NULL DEFAULT で埋まるが念のため）
UPDATE public.events
SET image_usage_status = 'unknown'
WHERE image_usage_status IS NULL;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_image_usage_status_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_image_usage_status_check
  CHECK (
    image_usage_status IN (
      'unknown',
      'licensed',
      'organizer_granted',
      'own',
      'forbidden'
    )
  );

COMMENT ON COLUMN public.events.image_usage_status IS
  'unknown|licensed|organizer_granted|own|forbidden — only licensed/organizer_granted/own may render publicly';

COMMENT ON COLUMN public.events.image_credit IS
  'Required credit text when displaying a licensed/organizer image';

COMMENT ON COLUMN public.events.image_source IS
  'gotokyo|enjoytokyo|organizer|seekigo|other (extensible)';

-- 過去 published の外部画像補正は別ファイル案を参照:
-- scripts/backfill-image-usage-unknown.sql
