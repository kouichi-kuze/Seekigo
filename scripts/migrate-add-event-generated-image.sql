-- Seekigo: イベント専用イメージ画像（生成画像）の状態を events に追加する。
--
-- 実行: Supabase SQL Editor に貼り付けて手動実行（このファイルは自動実行しない）
-- image_url / image_usage_status / image_credit / 本文は変更しない。
-- 既存行の generated_image_status は DEFAULT 'none' で埋まる。

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS generated_image_url text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS generated_image_status text NOT NULL DEFAULT 'none';

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_generated_image_status_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_generated_image_status_check
  CHECK (generated_image_status IN ('none', 'pending', 'approved', 'rejected'));

COMMENT ON COLUMN public.events.generated_image_url IS
  'Adopted or pending concept image URL. Local path (/images/event-generated/{id}.webp) or a future storage URL. Not a photograph of the real event.';

COMMENT ON COLUMN public.events.generated_image_status IS
  'none | pending | approved | rejected. Public pages show the image only when approved and no usable official image exists.';
