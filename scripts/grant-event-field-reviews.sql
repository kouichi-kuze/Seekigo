-- Seekigo: event_field_reviews への service_role 権限付与のみ
-- CREATE TABLE は再実行しない（テーブルは作成済み前提）
--
-- 実行: Supabase SQL Editor に貼り付けて実行

GRANT SELECT, INSERT, UPDATE ON public.event_field_reviews TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'event_field_reviews_id_seq'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.event_field_reviews_id_seq TO service_role';
  END IF;
END $$;

REVOKE ALL ON public.event_field_reviews FROM anon, authenticated;

ALTER TABLE public.event_field_reviews ENABLE ROW LEVEL SECURITY;
