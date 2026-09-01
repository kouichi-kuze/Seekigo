-- Seekigo: walkerplus を event_sources / event_dedupe_reviews の source_name に追加
--
-- 実行: Supabase SQL Editor に貼り付けて手動実行（自動実行しない）
-- Phase 1A 以降、Walkerplus 手動 import / dedupe review で必要

-- event_sources
ALTER TABLE public.event_sources
  DROP CONSTRAINT IF EXISTS event_sources_source_name_check;

ALTER TABLE public.event_sources
  ADD CONSTRAINT event_sources_source_name_check
  CHECK (source_name IN ('gotokyo', 'enjoytokyo', 'walkerplus'));

COMMENT ON COLUMN public.event_sources.source_name IS
  'Source key: gotokyo | enjoytokyo | walkerplus';

-- event_dedupe_reviews
ALTER TABLE public.event_dedupe_reviews
  DROP CONSTRAINT IF EXISTS event_dedupe_reviews_incoming_source_name_check;

ALTER TABLE public.event_dedupe_reviews
  ADD CONSTRAINT event_dedupe_reviews_incoming_source_name_check
  CHECK (incoming_source_name IN ('gotokyo', 'enjoytokyo', 'walkerplus'));
