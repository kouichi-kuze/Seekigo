-- Seekigo: イベント専用イメージ画像の入手方法と追加指示を events に追加する。
--
-- 実行: Supabase SQL Editor に貼り付けて手動実行（このファイルは自動実行しない）
-- generated_image_url / generated_image_status / image_url / 本文は変更しない。
-- 既存行の generated_image_source と generated_image_instruction は NULL のまま。

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS generated_image_source text;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS generated_image_instruction text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_generated_image_source_check;

ALTER TABLE public.events
  ADD CONSTRAINT events_generated_image_source_check
  CHECK (
    generated_image_source IS NULL
    OR generated_image_source IN ('openai', 'upload')
  );

COMMENT ON COLUMN public.events.generated_image_source IS
  'How the concept image was made: openai, upload, or NULL when unset.';

COMMENT ON COLUMN public.events.generated_image_instruction IS
  'Optional editor instruction appended to the standard prompt. NULL for standard generation and uploads.';
