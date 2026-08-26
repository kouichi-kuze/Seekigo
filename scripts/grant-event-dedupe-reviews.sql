-- Seekigo: event_dedupe_reviews への service_role 権限付与のみ
-- CREATE TABLE は再実行しない（テーブルは作成済み前提）
--
-- 確認結果: service_role / anon とも permission denied (42501)
-- → GRANT が未設定のため、以下を Supabase SQL Editor で実行してください。

GRANT SELECT, INSERT, UPDATE ON public.event_dedupe_reviews TO service_role;

-- identity 列がある場合
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'event_dedupe_reviews_id_seq'
  ) THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.event_dedupe_reviews_id_seq TO service_role';
  END IF;
END $$;

-- 念のため公開ロールから剥奪（既に拒否されているが明示）
REVOKE ALL ON public.event_dedupe_reviews FROM anon, authenticated;

-- RLS が無効なら有効化（既に有効なら無害）
ALTER TABLE public.event_dedupe_reviews ENABLE ROW LEVEL SECURITY;

-- カラム存在確認（不足があれば結果を見て別途 ALTER）
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'event_dedupe_reviews'
-- ORDER BY ordinal_position;
