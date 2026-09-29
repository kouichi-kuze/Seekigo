-- 監査で夜向けと決めた published 7件だけ is_night を true にする。
-- 現在 true の id 39 / 96 は対象外。price_text や他列は変えない。
-- 再実行しても、同じタイトルで null または true の行だけが true になる。

-- SELECT id, title, is_night
-- FROM public.events
-- WHERE status = 'published'
--   AND id IN (99, 127, 113, 126, 129, 109, 118)
-- ORDER BY id;

UPDATE public.events
SET is_night = true
WHERE id = 99 AND status = 'published'
  AND title LIKE '抹茶ビアガーデン%'
  AND (is_night IS NULL OR is_night = true);

UPDATE public.events
SET is_night = true
WHERE id = 127 AND status = 'published'
  AND title LIKE 'サンセットビーチ・オーストラリアビアガーデン%'
  AND (is_night IS NULL OR is_night = true);

UPDATE public.events
SET is_night = true
WHERE id = 113 AND status = 'published'
  AND title LIKE '池袋熱帯夜市%'
  AND (is_night IS NULL OR is_night = true);

UPDATE public.events
SET is_night = true
WHERE id = 126 AND status = 'published'
  AND title LIKE 'オクトーバーフェスト%'
  AND (is_night IS NULL OR is_night = true);

UPDATE public.events
SET is_night = true
WHERE id = 129 AND status = 'published'
  AND title LIKE '韓国酒場ビアガーデン%'
  AND (is_night IS NULL OR is_night = true);

UPDATE public.events
SET is_night = true
WHERE id = 109 AND status = 'published'
  AND title LIKE '森のビアガーデン%'
  AND (is_night IS NULL OR is_night = true);

UPDATE public.events
SET is_night = true
WHERE id = 118 AND status = 'published'
  AND title LIKE 'お祭りBBQ%'
  AND (is_night IS NULL OR is_night = true);
