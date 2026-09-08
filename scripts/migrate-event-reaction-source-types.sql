-- Seekigo Phase 4B-1: expand event_reaction_sources.source_type
--
-- 実行: Supabase SQL Editor に貼り付けて手動実行（自動適用しない）
-- 既存値: x | instagram | web | blog | news | other
-- 追加: official_web | rss | press_release | other_web

ALTER TABLE public.event_reaction_sources
  DROP CONSTRAINT IF EXISTS event_reaction_sources_source_type_check;

ALTER TABLE public.event_reaction_sources
  ADD CONSTRAINT event_reaction_sources_source_type_check
  CHECK (
    source_type IN (
      'x',
      'instagram',
      'web',
      'blog',
      'news',
      'other',
      'official_web',
      'rss',
      'press_release',
      'other_web'
    )
  );

COMMENT ON COLUMN public.event_reaction_sources.source_type IS
  'x|instagram|web|blog|news|other|official_web|rss|press_release|other_web';
