-- Seekigo Phase 4B-1: optional app-assist index for reaction source dedupe
--
-- 実行: 手動（自動適用しない）
-- UNIQUE は正規化 URL を DB に持たないため付けない。
-- アプリ側で normalizeUrl(event_id + url) により冪等化する。
-- 参照高速化のための非 UNIQUE index のみ。

CREATE INDEX IF NOT EXISTS event_reaction_sources_event_url_idx
  ON public.event_reaction_sources (event_id, source_url);

COMMENT ON INDEX public.event_reaction_sources_event_url_idx IS
  'Lookup aid for collector dedupe by event_id + source_url. Exact uniqueness is app-side via normalized URL.';
