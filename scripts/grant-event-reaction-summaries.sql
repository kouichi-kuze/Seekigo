-- Seekigo Phase 4A: service_role 権限のみ（テーブル作成済み前提）
-- 実行: Supabase SQL Editor

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_reaction_summaries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_reaction_sources TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'event_reaction_summaries_id_seq'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.event_reaction_summaries_id_seq TO service_role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'event_reaction_sources_id_seq'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.event_reaction_sources_id_seq TO service_role';
  END IF;
END $$;

REVOKE ALL ON public.event_reaction_sources FROM anon, authenticated;
REVOKE ALL ON public.event_reaction_summaries FROM anon, authenticated;
GRANT SELECT ON public.event_reaction_summaries TO anon, authenticated;

ALTER TABLE public.event_reaction_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reaction_sources ENABLE ROW LEVEL SECURITY;

-- published のみ公開 SELECT（idempotent）
DROP POLICY IF EXISTS "event_reaction_summaries_select_published"
  ON public.event_reaction_summaries;
CREATE POLICY "event_reaction_summaries_select_published"
  ON public.event_reaction_summaries
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published');

-- sources には公開 SELECT ポリシーを作らない（excerpt 保護）
