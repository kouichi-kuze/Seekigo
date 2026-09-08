-- Seekigo Phase 4A: 手動テスト用ダミー要約
--
-- 使い方:
-- 1) create-event-reaction-summaries.sql を先に実行
-- 2) 下の event_id を実在する published イベントに書き換えて実行
-- 3) admin / 公開ページで表示確認
-- 4) status を 'hidden' に UPDATE して公開非表示を確認
--
-- ※ Supabase へ勝手に適用しない。値はダミーです。

-- ★ ここを実在の published event id に変更
-- SELECT id, title, slug, status FROM public.events WHERE status = 'published' ORDER BY id LIMIT 5;

DO $$
DECLARE
  v_event_id bigint := 2; -- ← 書き換え
  v_summary_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.events WHERE id = v_event_id AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'published event id=% not found — edit v_event_id in this script', v_event_id;
  END IF;

  INSERT INTO public.event_reaction_summaries AS s (
    event_id,
    summary_bullets,
    signals,
    source_count,
    confidence,
    status,
    generated_at,
    reviewed_at,
    reviewed_by
  )
  VALUES (
    v_event_id,
    jsonb_build_array(
      '週末は混雑したという反応が多めです',
      '子ども連れでも楽しめたという声があります',
      '夕方は比較的見やすいという傾向があります'
    ),
    jsonb_build_object(
      'crowd_level', 'high',
      'family', true,
      'date', true,
      'solo', false,
      'photo', true,
      'rain', false,
      'wait_time', 'medium',
      'recommended_time', '夕方'
    ),
    3,
    'medium',
    'draft', -- 実機確認: draft → Publish → Hidden
    now() - interval '2 days',
    null,
    null
  )
  ON CONFLICT (event_id) DO UPDATE
  SET
    summary_bullets = EXCLUDED.summary_bullets,
    signals = EXCLUDED.signals,
    source_count = EXCLUDED.source_count,
    confidence = EXCLUDED.confidence,
    status = EXCLUDED.status,
    generated_at = EXCLUDED.generated_at,
    reviewed_at = EXCLUDED.reviewed_at,
    reviewed_by = EXCLUDED.reviewed_by
  RETURNING id INTO v_summary_id;

  DELETE FROM public.event_reaction_sources WHERE summary_id = v_summary_id;

  INSERT INTO public.event_reaction_sources (
    event_id,
    summary_id,
    source_type,
    source_url,
    source_name,
    observed_at,
    excerpt_for_internal_review
  )
  VALUES
    (
      v_event_id,
      v_summary_id,
      'x',
      'https://example.com/dummy-x-thread',
      'X (dummy)',
      now() - interval '3 days',
      '（内部確認用ダミー）週末かなり並んだ、という投稿が複数'
    ),
    (
      v_event_id,
      v_summary_id,
      'web',
      'https://example.com/dummy-blog',
      'Blog (dummy)',
      now() - interval '4 days',
      '（内部確認用ダミー）子連れで回りやすい、という体験記'
    ),
    (
      v_event_id,
      v_summary_id,
      'instagram',
      'https://example.com/dummy-ig',
      'Instagram (dummy)',
      now() - interval '5 days',
      '（内部確認用ダミー）夕景が綺麗、という投稿'
    );

  RAISE NOTICE 'dummy reaction summary ready: event_id=% summary_id=%', v_event_id, v_summary_id;
END $$;

-- 非表示テスト用（必要なら実行）:
-- UPDATE public.event_reaction_summaries SET status = 'hidden' WHERE event_id = 2;
-- 再表示:
-- UPDATE public.event_reaction_summaries SET status = 'published' WHERE event_id = 2;
