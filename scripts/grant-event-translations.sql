-- Seekigo Phase 4C-6: permissions + RLS for translation tables
-- 実行: create-event-translations.sql の後に Supabase SQL Editor で実行

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_translations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_reaction_summary_translations TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'event_translations_id_seq'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.event_translations_id_seq TO service_role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'event_reaction_summary_translations_id_seq'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.event_reaction_summary_translations_id_seq TO service_role';
  END IF;
END $$;

REVOKE ALL ON public.event_translations FROM anon, authenticated;
REVOKE ALL ON public.event_reaction_summary_translations FROM anon, authenticated;

GRANT SELECT ON public.event_translations TO anon, authenticated;
GRANT SELECT ON public.event_reaction_summary_translations TO anon, authenticated;

ALTER TABLE public.event_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reaction_summary_translations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "event_translations_select_published"
  ON public.event_translations;
CREATE POLICY "event_translations_select_published"
  ON public.event_translations
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published');

DROP POLICY IF EXISTS "event_reaction_summary_translations_select_published"
  ON public.event_reaction_summary_translations;
CREATE POLICY "event_reaction_summary_translations_select_published"
  ON public.event_reaction_summary_translations
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published');
