-- Seekigo: 既存 published の外部画像を unknown 扱いへ（実行は手動）
--
-- 対象: status=published かつ image_url が GO TOKYO / EnjoyTokyo の CDN/サイト
-- image_url 自体は削除しない。
--
-- 実行前に SELECT で件数・対象を確認すること。

-- 対象確認
SELECT
  id,
  slug,
  title,
  image_url,
  image_usage_status,
  image_source
FROM public.events
WHERE status = 'published'
  AND image_url IS NOT NULL
  AND (
    image_url ILIKE '%gotokyo.org%'
    OR image_url ILIKE '%enjoytokyo.jp%'
  )
ORDER BY id;

-- 補正（image_url は残す）
UPDATE public.events
SET
  image_usage_status = 'unknown',
  image_source = CASE
    WHEN image_url ILIKE '%gotokyo.org%' THEN 'gotokyo'
    WHEN image_url ILIKE '%enjoytokyo.jp%' THEN 'enjoytokyo'
    ELSE image_source
  END,
  updated_at = now()
WHERE status = 'published'
  AND image_url IS NOT NULL
  AND (
    image_url ILIKE '%gotokyo.org%'
    OR image_url ILIKE '%enjoytokyo.jp%'
  );
