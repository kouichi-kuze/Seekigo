-- 監査で確定した published 5件だけ category を直す。
-- 更新前の配列と完全一致した行だけ。再実行時は 0 件。
-- category 以外は変えない。

-- SELECT id, category
-- FROM public.events
-- WHERE status = 'published'
--   AND id IN (40, 77, 85, 112, 117)
-- ORDER BY id;

UPDATE public.events
SET category = ARRAY['exhibition']::text[]
WHERE id = 40
  AND status = 'published'
  AND category @> ARRAY['other']::text[]
  AND ARRAY['other']::text[] @> category;

UPDATE public.events
SET category = ARRAY['sports']::text[]
WHERE id = 77
  AND status = 'published'
  AND category @> ARRAY['sports', 'other']::text[]
  AND ARRAY['sports', 'other']::text[] @> category;

UPDATE public.events
SET category = ARRAY['exhibition']::text[]
WHERE id = 85
  AND status = 'published'
  AND category @> ARRAY['exhibition', 'other']::text[]
  AND ARRAY['exhibition', 'other']::text[] @> category;

UPDATE public.events
SET category = ARRAY['festival', 'kids']::text[]
WHERE id = 112
  AND status = 'published'
  AND category @> ARRAY['festival', 'other', 'kids']::text[]
  AND ARRAY['festival', 'other', 'kids']::text[] @> category;

UPDATE public.events
SET category = ARRAY['exhibition']::text[]
WHERE id = 117
  AND status = 'published'
  AND category @> ARRAY['other']::text[]
  AND ARRAY['other']::text[] @> category;
