-- Walkerplus migration 確認用（Supabase SQL Editor で実行）
-- .env の PUBLIC_SUPABASE_URL と同じプロジェクトで実行してください。

SELECT conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
WHERE t.relname = 'event_sources'
  AND c.contype = 'c'
  AND conname = 'event_sources_source_name_check';

-- 期待値: CHECK ((source_name = ANY (ARRAY['gotokyo'::text, 'enjoytokyo'::text, 'walkerplus'::text])))
-- walkerplus が含まれていなければ scripts/migrate-add-walkerplus-source.sql を実行
