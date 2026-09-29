-- 保存済み料金文だけで確定した published の is_free と単一料金。
-- price_text は変えない。再実行しても同じ結果。

-- SELECT id, is_free, price_min, price_max, price_text
-- FROM public.events
-- WHERE status = 'published'
--   AND id IN (40, 41, 100, 108, 122, 9, 17, 18, 21, 38, 45, 72, 90, 91, 92, 101, 107, 118, 128, 130)
-- ORDER BY id;

UPDATE public.events
SET is_free = false
WHERE id = 40 AND status = 'published'
  AND price_text LIKE '%平日1800円%'
  AND (is_free IS NULL OR is_free = false);

UPDATE public.events
SET is_free = false
WHERE id = 41 AND status = 'published'
  AND price_text LIKE '%3900円%'
  AND (is_free IS NULL OR is_free = false);

UPDATE public.events
SET is_free = false
WHERE id = 122 AND status = 'published'
  AND price_text LIKE '%2400円%'
  AND (is_free IS NULL OR is_free = false);

UPDATE public.events
SET is_free = false
WHERE id = 108 AND status = 'published'
  AND price_text LIKE '%2500円%'
  AND (is_free IS TRUE OR is_free = false);

UPDATE public.events
SET is_free = false, price_min = 3300, price_max = 3300
WHERE id = 100 AND status = 'published'
  AND price_text LIKE '%3,300円%'
  AND (is_free IS TRUE OR is_free = false)
  AND (price_min IS NULL OR price_min = 3300)
  AND (price_max IS NULL OR price_max = 3300);

UPDATE public.events SET price_min = 1500, price_max = 1500
WHERE id = 9 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1,500円%'
  AND (price_min IS NULL OR price_min = 1500)
  AND (price_max IS NULL OR price_max = 1500);

UPDATE public.events SET price_min = 1400, price_max = 1400
WHERE id = 17 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1,400円%'
  AND (price_min IS NULL OR price_min = 1400)
  AND (price_max IS NULL OR price_max = 1400);

UPDATE public.events SET price_min = 1400, price_max = 1400
WHERE id = 18 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1,400円%'
  AND (price_min IS NULL OR price_min = 1400)
  AND (price_max IS NULL OR price_max = 1400);

UPDATE public.events SET price_min = 1500, price_max = 1500
WHERE id = 21 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1,500円%'
  AND (price_min IS NULL OR price_min = 1500)
  AND (price_max IS NULL OR price_max = 1500);

UPDATE public.events SET price_min = 1500, price_max = 1500
WHERE id = 38 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1,500円%'
  AND (price_min IS NULL OR price_min = 1500)
  AND (price_max IS NULL OR price_max = 1500);

UPDATE public.events SET price_min = 2400, price_max = 2400
WHERE id = 45 AND status = 'published' AND is_free = false
  AND price_text LIKE '%2400円%'
  AND (price_min IS NULL OR price_min = 2400)
  AND (price_max IS NULL OR price_max = 2400);

UPDATE public.events SET price_min = 400, price_max = 400
WHERE id = 72 AND status = 'published' AND is_free = false
  AND price_text LIKE '%400円%'
  AND (price_min IS NULL OR price_min = 400)
  AND (price_max IS NULL OR price_max = 400);

UPDATE public.events SET price_min = 500, price_max = 500
WHERE id = 90 AND status = 'published' AND is_free = false
  AND price_text LIKE '%500円%'
  AND (price_min IS NULL OR price_min = 500)
  AND (price_max IS NULL OR price_max = 500);

UPDATE public.events SET price_min = 1500, price_max = 1500
WHERE id = 91 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1,500円%'
  AND (price_min IS NULL OR price_min = 1500)
  AND (price_max IS NULL OR price_max = 1500);

UPDATE public.events SET price_min = 220, price_max = 220
WHERE id = 92 AND status = 'published' AND is_free = false
  AND price_text LIKE '%220円%'
  AND (price_min IS NULL OR price_min = 220)
  AND (price_max IS NULL OR price_max = 220);

UPDATE public.events SET price_min = 3600, price_max = 3600
WHERE id = 101 AND status = 'published' AND is_free = false
  AND price_text LIKE '%3600円%'
  AND (price_min IS NULL OR price_min = 3600)
  AND (price_max IS NULL OR price_max = 3600);

UPDATE public.events SET price_min = 2000, price_max = 2000
WHERE id = 107 AND status = 'published' AND is_free = false
  AND price_text LIKE '%2000円%'
  AND (price_min IS NULL OR price_min = 2000)
  AND (price_max IS NULL OR price_max = 2000);

UPDATE public.events SET price_min = 4840, price_max = 4840
WHERE id = 118 AND status = 'published' AND is_free = false
  AND price_text LIKE '%4840円%'
  AND (price_min IS NULL OR price_min = 4840)
  AND (price_max IS NULL OR price_max = 4840);

UPDATE public.events SET price_min = 1400, price_max = 1400
WHERE id = 128 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1400円%'
  AND (price_min IS NULL OR price_min = 1400)
  AND (price_max IS NULL OR price_max = 1400);

UPDATE public.events SET price_min = 1900, price_max = 1900
WHERE id = 130 AND status = 'published' AND is_free = false
  AND price_text LIKE '%1900円%'
  AND (price_min IS NULL OR price_min = 1900)
  AND (price_max IS NULL OR price_max = 1900);
