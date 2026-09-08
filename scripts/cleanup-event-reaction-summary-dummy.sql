-- Seekigo Phase 4A: テスト用 dummy のみ削除（events 本体は触らない）
--
-- ★ event_id を seed / 実機テストで使った ID に合わせてから実行

DO $$
DECLARE
  v_event_id bigint := 2; -- ← 書き換え
  v_deleted_sources integer;
  v_deleted_summaries integer;
BEGIN
  DELETE FROM public.event_reaction_sources
  WHERE event_id = v_event_id;
  GET DIAGNOSTICS v_deleted_sources = ROW_COUNT;

  DELETE FROM public.event_reaction_summaries
  WHERE event_id = v_event_id;
  GET DIAGNOSTICS v_deleted_summaries = ROW_COUNT;

  RAISE NOTICE
    'cleanup reaction dummy: event_id=% sources=% summaries=% (events untouched)',
    v_event_id, v_deleted_sources, v_deleted_summaries;
END $$;
