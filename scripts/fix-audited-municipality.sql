-- 監査で根拠が確認できた published 14件だけ municipality を直す。
-- id 34 と 66 だけ area を NULL にする。他の列は変えない。
-- 修正前の値か、修正後の値のときだけ一致する。再実行しても対象外は変わらない。

-- 確認用
-- SELECT id, municipality, area
-- FROM events
-- WHERE status = 'published'
--   AND id IN (34, 66, 72, 96, 15, 16, 91, 94, 65, 7, 12, 76, 77, 83)
-- ORDER BY id;

UPDATE public.events
SET municipality = 'bunkyo', area = NULL
WHERE id = 34
  AND status = 'published'
  AND (
    (municipality = 'taito' AND area = 'ueno')
    OR (municipality = 'bunkyo' AND area IS NULL)
  );

UPDATE public.events
SET municipality = 'bunkyo', area = NULL
WHERE id = 66
  AND status = 'published'
  AND (
    (municipality = 'taito' AND area = 'ueno')
    OR (municipality = 'bunkyo' AND area IS NULL)
  );

UPDATE public.events
SET municipality = 'koganei'
WHERE id = 72
  AND status = 'published'
  AND area IS NULL
  AND municipality IN ('chuo', 'koganei');

UPDATE public.events
SET municipality = 'tachikawa'
WHERE id = 96
  AND status = 'published'
  AND area IS NULL
  AND municipality IN ('tama', 'tachikawa');

UPDATE public.events
SET municipality = 'chiyoda'
WHERE id = 15
  AND status = 'published'
  AND area IS NULL
  AND municipality IN ('chuo', 'chiyoda');

UPDATE public.events
SET municipality = 'chiyoda'
WHERE id = 16
  AND status = 'published'
  AND area IS NULL
  AND municipality IN ('chuo', 'chiyoda');

UPDATE public.events
SET municipality = 'shibuya'
WHERE id = 91
  AND status = 'published'
  AND area IS NULL
  AND municipality IN ('minato', 'shibuya');

UPDATE public.events
SET municipality = 'setagaya'
WHERE id = 94
  AND status = 'published'
  AND area IS NULL
  AND municipality IN ('tama', 'setagaya');

UPDATE public.events
SET municipality = 'bunkyo'
WHERE id = 65
  AND status = 'published'
  AND area IS NULL
  AND (municipality IS NULL OR municipality = 'bunkyo');

UPDATE public.events
SET municipality = 'kita'
WHERE id = 7
  AND status = 'published'
  AND area = 'oji'
  AND (municipality IS NULL OR municipality = 'kita');

UPDATE public.events
SET municipality = 'shinagawa'
WHERE id = 12
  AND status = 'published'
  AND area IS NULL
  AND (municipality IS NULL OR municipality = 'shinagawa');

UPDATE public.events
SET municipality = 'minato'
WHERE id = 76
  AND status = 'published'
  AND area IS NULL
  AND (municipality IS NULL OR municipality = 'minato');

UPDATE public.events
SET municipality = 'minato'
WHERE id = 77
  AND status = 'published'
  AND area IS NULL
  AND (municipality IS NULL OR municipality = 'minato');

UPDATE public.events
SET municipality = 'minato'
WHERE id = 83
  AND status = 'published'
  AND area IS NULL
  AND (municipality IS NULL OR municipality = 'minato');
